// Zweck: Eine Engine installiert und aktualisiert die Skills und Hooks aller Anbieter (Ponytail, Impeccable, Matt Pocock).
// Aufruf: node <kit>/scripts/provider.mjs [--cwd PROJEKT] <ponytail|impeccable|matt-pocock> <setup|install|update>
//   setup:   die gepinnten Skills als gewoehnliche, committbare Dateien ins Projekt schreiben.
//   install: die geprueften Hook-Dateien unter dem Benutzerverzeichnis ablegen, ausserhalb jedes Checkouts.
//   update:  (nur im Kit-Checkout) einen neuen Pin in die Kit-Daten uebernehmen, danach setup.
// Ein Anbieter ist eine Beschreibung in provider-<name>.mjs (Quelle, Dateien, Patch, Ziel); die Sicherheitsregeln stehen nur hier:
// sauberer Quell-Pin, Staging ausserhalb der Ausgabe, Sperre, Pruefsumme vor dem Veroeffentlichen, nie ueberschreiben, Aufraeumen, Fehlerprotokoll.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, externalTool, projectRoot } from './checkout-root.mjs';
import { checkDirectory, linkSkills, localDirectory, materialize, moveAside, rename } from './provider-links.mjs';

// A fourth provider is one file and one line here.
const providers = {
  ponytail: () => import('./provider-ponytail.mjs'),
  impeccable: () => import('./provider-impeccable.mjs'),
  'matt-pocock': () => import('./provider-matt-pocock.mjs'),
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const abandoned = (lock, stale) => {
  try { process.kill(Number(readFileSync(join(lock, 'pid'), 'utf8')), 0); } catch (error) { if (error.code === 'ESRCH') return true; }
  try { return Date.now() - statSync(lock).mtimeMs > stale; } catch { return true; }
};

/** Runs `work` while it holds the lock directory. A holder that died (its pid is gone) or hung (older than `stale` ms) is taken over; a live one is waited for up to `wait` ms
 * (longer than one 120 s download, so a second run does not give up on the first). */
export async function withLock(lock, work, { stale = 15 * 60_000, wait = 300_000 } = {}) {
  for (const give = Date.now() + wait; ;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (abandoned(lock, stale)) {
        // shortcut: two takers that find the same dead lock race on the rename; a third run that locks in between is not told apart, upgrade to an owner token if that ever shows.
        try { renameSync(lock, `${lock}.dead-${process.pid}`); rmSync(`${lock}.dead-${process.pid}`, { recursive: true, force: true }); } catch { /* another run took it first */ }
        continue;
      }
      assert.ok(Date.now() < give, `Another run holds ${lock}; run again when it is done.`);
      await sleep(100);
    }
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** `withLock` on `<dir>/.<name>.lock`; a failure is written to `<dir>/.<name>.log` (replaced every run, removed after a success). */
export async function guarded(dir, name, work, options) {
  const log = join(dir, `.${name}.log`);
  try {
    const result = await withLock(join(dir, `.${name}.lock`), work, options);
    rmSync(log, { force: true });
    return result;
  } catch (error) {
    // No time in the log: a repeated failure leaves the same bytes, the file date says when. A log that cannot be written must not hide the error.
    try { writeFileSync(log, `${error.stack ?? error}\n`); } catch { /* the error below is the report */ }
    throw error;
  }
}

const insideCheckout = directory => {
  for (; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return true;
    if (directory === dirname(directory)) return false;
  }
};
/** Personal trusted code must live outside every checkout. The existing part of `path` is resolved first, so junctions cannot hide a checkout. */
export function outsideCheckouts(path, message) {
  let existing = path;
  const missing = [];
  while (!existsSync(existing)) { missing.unshift(basename(existing)); existing = dirname(existing); }
  assert.ok(!insideCheckout(join(realpathSync(existing), ...missing)), message);
}

/** The kit, the project the command runs in and the tools it needs; Git is the installed one, never a program of the checkout or the working directory. */
export function context({ kit = resolve(dirname(fileURLToPath(import.meta.url)), '..'), home = homedir() } = {}) {
  const root = projectRoot();
  let tool;
  return {
    kit, root, home, outside: outsideCheckouts,
    git(...args) {
      tool ??= externalTool('git', root, kit, process.cwd());
      return execFileSync(tool.file, args, { cwd: root, env: tool.env, encoding: 'utf8' });
    },
    text: path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n'),
    versions: JSON.parse(readFileSync(join(kit, 'scripts/versions.json'), 'utf8')),
  };
}

/** The submodule of the provider, checked out at the kit's pin and free of local changes (also hidden ones). */
function pinnedSource(p, c) {
  const source = join(c.kit, p.source);
  checkDirectory(c.kit, source);
  const clean = () => {
    assert.equal(c.git('-C', source, 'status', '--porcelain', '--untracked-files=all').trim(), '', `${p.label} source has local changes; preserve/review them before updating`);
    // assume-unchanged (lowercase tag) or skip-worktree (S) would hide edits from the status check.
    assert.ok(!/^(?:[a-z]|S) /m.test(c.git('-C', source, 'ls-files', '-v')), `${p.label} source hides local changes from git status`);
  };
  if (existsSync(join(source, '.git'))) clean();
  c.git('-C', c.kit, 'submodule', 'update', '--init', '--', p.source);
  clean();
  const revision = c.git('-C', source, 'rev-parse', 'HEAD').trim();
  // submodule.<name>.update=none skips the checkout above; only the kit's pin may be packaged.
  assert.equal(revision, c.git('-C', c.kit, 'rev-parse', `:${p.source}`).trim(), `${p.label} source is not at the kit pin`);
  return { source, revision };
}

/**
 * Publishes the pinned skills into the project. The provider's `build(c, next)` writes the files into a staging folder and returns
 * `{ outputs: [[project path, path in next]], retire: [absolute paths to move aside], message }`; nothing else touches the project.
 */
export async function setup(p, c) {
  return publish(p, { ...c, ...pinnedSource(p, c) });
}

export async function publish(p, c) {
  const state = join(c.root, '.workflow-kit');
  localDirectory(c.root, state);
  await guarded(state, p.name, async () => {
    const stage = mkdtempSync(join(state, `${p.name}-`)), next = join(stage, 'next');
    try {
      const { outputs, retire = [], message } = await p.build(c, next);
      // Reject redirected ancestors before replacing any output. Changed or foreign files move aside, equal ones stay.
      checkDirectory(c.root, join(state, 'replaced'));
      for (const [path] of outputs) localDirectory(c.root, dirname(join(c.root, path)));
      for (const [path, from] of outputs) materialize(c.root, join(c.root, path), join(next, from));
      for (const path of retire) moveAside(c.root, path);
      linkSkills(c.root);
      console.log(message);
    } finally {
      // Only this run's staging, confined to the state folder.
      assert.equal(dirname(stage), state);
      assert.ok(!lstatSync(stage).isSymbolicLink());
      rmSync(stage, { recursive: true, force: true });
    }
  });
}

/** Bytes of one wanted file; a download is checked against its reviewed SHA256 before anything is stored. */
async function bytesOf(name, entry) {
  if (entry.bytes) return entry.bytes;
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
  assert.ok(response.ok, `Download of ${name} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(sha256(bytes), entry.sha256, `${name} does not match its reviewed SHA256; refusing installation`);
  return bytes;
}

/**
 * Installs the personal files of a provider below `home`. The provider's `install` names the folder (`home` parts, `directory(version)`), the wanted files
 * (`files(c, version)`: name -> { bytes } or { url, sha256 }, optional `mode`) and optional `before(c)` / `after(destination, c)` steps.
 * The folder is published whole and atomically; an existing one is only verified, never replaced.
 */
export async function install(p, c) {
  const i = p.install, version = c.versions[p.name];
  const parent = join(c.home, ...i.home), destination = join(parent, i.directory(version));
  c.outside(destination, `${p.label} installation must be outside Git checkouts. Use a personal home outside any checkout before installing or enabling hooks.`);
  i.before?.(c);
  const wanted = i.files(c, version);
  mkdirSync(parent, { recursive: true });
  await guarded(parent, p.name, async () => {
    if (!existsSync(destination) || !readdirSync(destination).length) {
      // The folder of a download that failed in an older kit version stays empty.
      if (existsSync(destination)) rmdirSync(destination);
      const stage = mkdtempSync(join(parent, '.install-'));
      try {
        for (const [name, entry] of Object.entries(wanted)) {
          mkdirSync(dirname(join(stage, name)), { recursive: true });
          writeFileSync(join(stage, name), await bytesOf(name, entry), { mode: entry.mode });
        }
        try {
          rename(stage, destination);
        } catch (error) {
          // A concurrent identical installation is already the desired result; verification below decides.
          if (!existsSync(destination)) throw error;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    // Installed code is immutable per version: whatever is there must be the reviewed bytes.
    for (const [name, entry] of Object.entries(wanted)) {
      const file = join(destination, name);
      const bytes = existsSync(file) ? readFileSync(file) : null;
      assert.ok(bytes && (entry.bytes ? bytes.equals(entry.bytes) : sha256(bytes) === entry.sha256),
        `${p.label} ${name} in ${destination} differs from the reviewed version; the existing installation was not replaced. Inspect or remove it explicitly before reinstalling.`);
      // A verified file that lost its executable bit would keep the SessionStart hint alive: restore the mode on Unix.
      if (entry.mode && process.platform !== 'win32') chmodSync(file, entry.mode);
    }
    await i.after?.(destination, c);
    console.log(`${p.label} hooks installed: ${destination}`);
    // Name, never delete: other checkouts may still pin an older version, and every start reinstalls what its checkout pins, so deleting would make checkouts on different versions reinstall each other's in turn.
    const list = dir => readdirSync(dir).filter(name => !name.startsWith('.')).map(name => join(dir, name));
    const unused = list(dirname(parent)).flatMap(dir => dir === parent ? list(dir).filter(old => old !== destination) : [dir]);
    if (unused.length) console.log(`Unused older ${p.label} installations, delete when no checkout pins them: ${unused.join(', ')}`);
    console.log('Review and enable the project hooks in your agent; start a fresh session. No hook trust or personal agent settings were changed.');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  enterCwd();
  const [name, action, ...extra] = process.argv.slice(2);
  const run = { setup, install };
  if (!(name in providers) || !['setup', 'install', 'update'].includes(action) || extra.length > (action === 'update' ? 1 : 0)) {
    console.error(`Usage: node <kit>/scripts/provider.mjs [--cwd PROJECT_DIR] <${Object.keys(providers).join('|')}> <setup|install|update [PREVIOUS_UPSTREAM_REVISION]>`);
    process.exit(2);
  }
  const { default: p } = await providers[name]();
  const c = context();
  assert.ok(action === 'setup' ? p.build : p[action], `${p.label} has no ${action}`);
  if (action === 'update') {
    assert.equal(c.root, c.kit, 'Run update inside the workflow-kit checkout');
    await p.update({ ...c, setup: () => setup(p, c) }, ...extra);
  } else await run[action](p, c);
}
