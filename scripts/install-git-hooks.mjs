import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { projectRoot } from './checkout-root.mjs';
import { gitResultIn } from './git-tool.mjs';
import { isMain } from './is-main.mjs';
import { rename } from './write-guard.mjs';

// Explicit setup, per clone: copies the project's .githooks into the clone's
// Git directory and points core.hooksPath there, so a checked-out branch cannot replace the hooks Git runs (#194).
// Only a rerun updates the copy. Automatic hooks never run this file. --check only reports.
/** Makes `to` hold exactly what `from` holds: renames over existing files, drops entries `from` lacks. */
function moveIn(from, to) {
  const wanted = readdirSync(from, { withFileTypes: true });
  for (const entry of readdirSync(to, { withFileTypes: true }))
    if (!wanted.some(item => item.name === entry.name && item.isDirectory() === entry.isDirectory()))
      rmSync(join(to, entry.name), { recursive: true, force: true });
  for (const entry of wanted) {
    if (entry.isDirectory()) {
      mkdirSync(join(to, entry.name), { recursive: true });
      moveIn(join(from, entry.name), join(to, entry.name));
    } else rename(join(from, entry.name), join(to, entry.name));
  }
}

/** Copies the project's .githooks into the clone's Git directory and points core.hooksPath there; `check` only reports. Prints what it did.
 * Returns { ready, reason }: not ready (with the reason) when a foreign core.hooksPath keeps the hooks from running. */
export function installGitHooks({ root, check = false, log = console.log }) {
  // Inherited repository selection (e.g. when called from a Git hook) would redirect Git away from root.
  const git = gitResultIn({ env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined } }, root);
  const run = (...args) => {
    const result = git(root, ...args);
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const out = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const report = message => log(`core.hooksPath: ${message}`);

  if (!statSync(join(root, '.githooks'), { throwIfNoEntry: false })?.isDirectory()) {
    report('no .githooks directory, nothing to do');
    return { ready: true };
  }

  // Every worktree's .githooks counts as ours, so an absolute path into another worktree is migrated too.
  // Existing paths are canonicalized (symlinks, Windows 8.3 names); missing ones compare as written.
  const fold = path => {
    let canonical = resolve(path);
    try { canonical = realpathSync.native(canonical); } catch { /* missing or inaccessible: keep as written */ }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  };
  // -z: NUL-separated attributes, so worktree paths may contain newlines.
  const tops = out('worktree', 'list', '--porcelain', '-z').split('\0')
    .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
  const hooksDir = join(resolve(root, out('rev-parse', '--git-common-dir')), 'workflow-kit-hooks');
  const hooksValue = hooksDir.replaceAll('\\', '/');
  const ours = new Set([hooksDir, ...tops.map(top => join(top, '.githooks'))].map(fold));
  // Git resolves a relative hooks path in whichever worktree runs the hook, so a relative value may point elsewhere and stays foreign.
  const isOurs = value => isAbsolute(value) && ours.has(fold(value));

  /** Every core.hooksPath entry of one config source as { value, origin }, including include/includeIf
   * files (a selected source skips them without --includes). --null keeps origins unquoted. */
  const entries = (...source) => {
    const result = run('config', ...source, '--includes', '--show-origin', '--null', '--get-all', 'core.hooksPath');
    assert.ok(result.status <= 1, result.stderr);
    const fields = result.status === 0 ? result.stdout.split('\0').slice(0, -1) : [];
    const list = [];
    for (let i = 0; i < fields.length; i += 2) {
      const origin = fields[i];
      list.push({ value: fields[i + 1], origin: origin.startsWith('file:') ? fold(resolve(root, origin.slice(5))) : origin });
    }
    return list;
  };
  /** A file is changed only when every entry it yields is ours and written in the file itself;
   * foreign, repeated foreign and included entries stay untouched and are reported. */
  const owned = (file, list) => list.every(entry => isOurs(entry.value) && entry.origin === fold(file));
  const describe = list => list.map(entry => `${entry.value} (${entry.origin})`).join(', ');

  const common = resolve(root, out('rev-parse', '--git-common-dir'));
  const localFile = join(common, 'config');
  const worktreeFiles = [join(common, 'config.worktree'),
    ...(existsSync(join(common, 'worktrees')) ? readdirSync(join(common, 'worktrees')) : [])
      .map(name => join(common, 'worktrees', name, 'config.worktree'))].filter(existsSync);

  /** Lines of `git var NAME` (the global or system config files Git reads), none when disabled. */
  const configFiles = name => {
    const result = run('var', name);
    assert.ok(result.status <= 1, result.stderr);
    return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
  };
  // Git evaluates includeIf (gitdir, onbranch, ...) only for the invoking worktree and branch, so a
  // foreign path that applies elsewhere is invisible above. Read every include target with its
  // condition ignored and keep everything when any target reachable through includeIf sets a foreign path.
  // A file is read once per state: reached first unconditionally, it may still be behind an includeIf elsewhere.
  // Targets this script cannot resolve like Git (~user/, %(prefix)/) block every change instead.
  const conditional = [];
  const scanned = new Set();
  const scan = (file, underCondition) => {
    const key = `${underCondition}:${fold(file)}`;
    if (scanned.has(key) || !existsSync(file)) return;
    scanned.add(key);
    const own = run('config', '--file', file, '--no-includes', '--null', '--get-all', 'core.hooksPath');
    assert.ok(own.status <= 1, own.stderr);
    if (underCondition && own.status === 0)
      conditional.push(...own.stdout.split('\0').slice(0, -1).map(value => ({ value, origin: fold(file) })));
    const includes = run('config', '--file', file, '--no-includes', '--null', '--get-regexp', '^include(if\\..*)?\\.path$');
    assert.ok(includes.status <= 1, includes.stderr);
    for (const entry of includes.status === 0 ? includes.stdout.split('\0').slice(0, -1) : []) {
      const name = entry.slice(0, entry.indexOf('\n')), path = entry.slice(entry.indexOf('\n') + 1);
      if (/^(~(?!\/)|%\()/.test(path)) {
        conditional.push({ value: `unresolved include ${path}`, origin: fold(file) });
        continue;
      }
      const target = path.startsWith('~/') ? join(process.env.HOME ?? homedir(), path.slice(2)) : resolve(dirname(file), path);
      scan(target, underCondition || name.startsWith('includeif.'));
    }
  };
  for (const file of [localFile, ...worktreeFiles, ...configFiles('GIT_CONFIG_GLOBAL'), ...configFiles('GIT_CONFIG_SYSTEM')])
    scan(file, false);
  const foreignConditional = conditional.filter(entry => !isOurs(entry.value));
  if (foreignConditional.length) {
    const reason = `includeIf may set ${describe(foreignConditional)}; integrate .githooks there by hand`;
    report(`kept as is: ${reason}`);
    return { ready: false, reason };
  }

  // Local config wins over global and system; an unset local must not shadow someone's global hooks.
  const local = entries('--file', localFile);
  const inherited = local.length ? [] : [...entries('--global'), ...entries('--system')];
  let ready = false, reason;
  if (inherited.some(entry => !isOurs(entry.value))) {
    reason = `foreign core.hooksPath ${describe(inherited)}; integrate .githooks there by hand`;
    report(`kept ${reason}`);
  } else if (local.length && local.every(entry => isAbsolute(entry.value) && fold(entry.value) === fold(hooksDir))) {
    ready = true;
    report(hooksValue);
  } else if (local.length && !owned(localFile, local)) {
    reason = `core.hooksPath ${describe(local)}; integrate .githooks there by hand`;
    report(`kept ${reason}`);
  } else {
    if (!check) out('config', '--file', localFile, '--replace-all', 'core.hooksPath', hooksValue);
    ready = true;
    report(`${check ? 'would set' : 'set'} ${hooksValue}${local.length ? ` (was ${describe(local)})` : ''}`);
  }
  // Own overrides go only once the local path is ours.
  for (const file of worktreeFiles) {
    const list = entries('--file', file);
    if (!list.length) continue;
    if (ready && owned(file, list)) {
      if (!check) out('config', '--file', file, '--unset-all', 'core.hooksPath');
      report(`${check ? 'would remove' : 'removed'} worktree override ${describe(list)}`);
    } else {
      reason ??= `worktree override core.hooksPath ${describe(list)}; integrate .githooks there by hand`;
      report(`kept worktree override ${describe(list)}`);
    }
  }

  // The copy is the trusted part: replaced on every explicit run, so removed hooks disappear too.
  // Symlinks stay out.
  if (ready) {
    if (check) {
      // Shared by every worktree of the clone: a copy that already matches has nothing open (#730).
      const files = base => !existsSync(base) ? {} : Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && !lstatSync(join(entry.parentPath, entry.name)).isSymbolicLink())
        .map(entry => { const path = join(entry.parentPath, entry.name); return [path.slice(base.length), readFileSync(path, 'utf8').replaceAll('\r\n', '\n')]; }));
      // Install makes every copied hook executable; Git skips one without the bit.
      const executable = process.platform === 'win32' || !existsSync(hooksDir)
        || readdirSync(hooksDir, { withFileTypes: true }).every(entry => !entry.isFile() || (statSync(join(hooksDir, entry.name)).mode & 0o111) === 0o111);
      const wanted = files(join(root, '.githooks')), installed = files(hooksDir);
      if (executable && JSON.stringify(Object.entries(wanted).sort()) === JSON.stringify(Object.entries(installed).sort()))
        log(`hooks: ${hooksValue} is current`);
      else log(`hooks: would copy .githooks into ${hooksValue}`);
    } else {
      // core.hooksPath already points at hooksDir and is shared by every worktree: build the copy beside it,
      // then move it in file by file (each rename atomic), so there is never a moment without complete hooks (#975).
      const staging = `${hooksDir}.new-${process.pid}`;
      try {
        rmSync(staging, { recursive: true, force: true });
        cpSync(join(root, '.githooks'), staging, { recursive: true, filter: source => !lstatSync(source).isSymbolicLink() });
        for (const name of readdirSync(staging)) if (lstatSync(join(staging, name)).isFile()) chmodSync(join(staging, name), 0o755);
        mkdirSync(hooksDir, { recursive: true });
        moveIn(staging, hooksDir);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      log(`hooks: copied .githooks into ${hooksValue}; rerun after changing a hook`);
    }
  }
  return { ready: ready && !reason, reason };
}

if (isMain(import.meta.url)) {
  const usage = `Usage: node scripts/install-git-hooks.mjs [--check]
Installs the .githooks of this project into the Git directory; --check only reports what would change.`;
  const [option, ...more] = process.argv.slice(2);
  if (option === '--help' || option === '-h') console.log(usage);
  else if (more.length || (option && option !== '--check')) { console.error(`${usage}
Unknown argument; nothing was changed.`); process.exitCode = 2; }
  else installGitHooks({ root: projectRoot(), check: option === '--check' });
}
