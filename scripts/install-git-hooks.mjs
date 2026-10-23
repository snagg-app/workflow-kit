import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { externalTool, projectRoot } from './checkout-root.mjs';

// Explicit setup, per clone: copies the project's .githooks (plus the kit's post-checkout kit sync) into the clone's
// Git directory and points core.hooksPath there, so a checked-out branch cannot replace the hooks Git runs (#194).
// Only a rerun updates the copy. Automatic hooks never run this file. --check only reports.
const root = projectRoot();
const check = process.argv.includes('--check');
const git = externalTool('git', root);
// Inherited repository selection (e.g. when called from a Git hook) would redirect Git away from root.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete git.env[name];
const run = (...args) => {
  const result = spawnSync(git.file, args, { cwd: root, env: git.env, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
};
const out = (...args) => {
  const result = run(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const report = message => console.log(`core.hooksPath: ${message}`);

if (!statSync(join(root, '.githooks'), { throwIfNoEntry: false })?.isDirectory()) {
  report('no .githooks directory, nothing to do');
  process.exit(0);
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
  report(`kept as is: includeIf may set ${describe(foreignConditional)}; integrate .githooks there by hand`);
  process.exit(0);
}

// Local config wins over global and system; an unset local must not shadow someone's global hooks.
const local = entries('--file', localFile);
const inherited = local.length ? [] : [...entries('--global'), ...entries('--system')];
let ready = false;
if (inherited.some(entry => !isOurs(entry.value))) {
  report(`kept foreign ${describe(inherited)}; integrate .githooks there by hand`);
} else if (local.length && local.every(entry => isAbsolute(entry.value) && fold(entry.value) === fold(hooksDir))) {
  ready = true;
  report(hooksValue);
} else if (local.length && !owned(localFile, local)) {
  report(`kept ${describe(local)}; integrate .githooks there by hand`);
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
    report(`kept worktree override ${describe(list)}`);
  }
}

// The copy is the trusted part: replaced on every explicit run, so removed hooks disappear too.
// Symlinks stay out. A project post-checkout of its own wins over the kit's.
if (ready) {
  const hook = join(hooksDir, 'post-checkout');
  if (check) {
    // Shared by every worktree of the clone: a copy that already matches has nothing open (#730).
    const files = base => !existsSync(base) ? {} : Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && !lstatSync(join(entry.parentPath, entry.name)).isSymbolicLink())
      .map(entry => { const path = join(entry.parentPath, entry.name); return [path.slice(base.length), readFileSync(path, 'utf8').replaceAll('\r\n', '\n')]; }));
    // Install makes every copied hook executable; Git skips one without the bit.
    const executable = process.platform === 'win32' || !existsSync(hooksDir)
      || readdirSync(hooksDir, { withFileTypes: true }).every(entry => !entry.isFile() || (statSync(join(hooksDir, entry.name)).mode & 0o111) === 0o111);
    const wanted = files(join(root, '.githooks')), installed = files(hooksDir);
    wanted[`${sep}post-checkout`] ??= readFileSync(new URL('./git-hooks/post-checkout', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    if (executable && JSON.stringify(Object.entries(wanted).sort()) === JSON.stringify(Object.entries(installed).sort()))
      console.log(`hooks: ${hooksValue} is current`);
    else console.log(`hooks: would copy .githooks into ${hooksValue}`);
  } else {
    rmSync(hooksDir, { recursive: true, force: true });
    mkdirSync(hooksDir, { recursive: true });
    cpSync(join(root, '.githooks'), hooksDir, { recursive: true, filter: source => !lstatSync(source).isSymbolicLink() });
    const kitHook = readFileSync(new URL('./git-hooks/post-checkout', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    if (!existsSync(hook)) writeFileSync(hook, kitHook);
    else if (readFileSync(hook, 'utf8') !== kitHook)
      console.log('hooks: kept the project post-checkout; integrate scripts/git-hooks/post-checkout there by hand');
    for (const name of readdirSync(hooksDir)) if (lstatSync(join(hooksDir, name)).isFile()) chmodSync(join(hooksDir, name), 0o755);
    console.log(`hooks: copied .githooks (and the kit post-checkout) into ${hooksValue}; rerun after changing a hook`);
  }
}
