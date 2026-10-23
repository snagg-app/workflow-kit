// Zweck: Eine Engine installiert und aktualisiert die Skills und Hooks aller Anbieter (Ponytail, Impeccable, Matt Pocock).
// Aufruf: node <kit>/scripts/provider.mjs [--cwd PROJEKT] <ponytail|impeccable|matt-pocock> <setup|install|update>
//   setup:   die gepinnten Skills als gewoehnliche, committbare Dateien ins Projekt schreiben.
//   install: die geprueften Hook-Dateien unter dem Benutzerverzeichnis ablegen, ausserhalb jedes Checkouts.
//   update:  (nur im Kit-Checkout) einen neuen Pin in die Kit-Daten uebernehmen, danach setup.
// Ein Anbieter ist eine Beschreibung in provider-<name>.mjs (Quelle, Dateien, Patch, Ziel); die Sicherheitsregeln stehen nur hier:
// sauberer Quell-Pin, Staging ausserhalb der Ausgabe, Sperre, Pruefsumme vor dem Veroeffentlichen, nie ueberschreiben, Aufraeumen, Fehlerprotokoll.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ancestors, enterCwd, hasGit, projectRoot } from './checkout-root.mjs';
import { gitIn } from './git-tool.mjs';
import { withLock } from './lock.mjs';
import { linkSkills, materialize } from './provider-links.mjs';
import { checkDirectory, localDirectory, moveAside, rename } from './write-guard.mjs';
import { providerList, providerNamed } from './provider-list.mjs';
import { readVersions } from './versions.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export { withLock };

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

const insideCheckout = directory => [...ancestors(directory)].some(hasGit);
/** Personal trusted code must live outside every checkout. The existing part of `path` is resolved first, so junctions cannot hide a checkout. */
export function outsideCheckouts(path, message) {
  let existing = path;
  const missing = [];
  while (!existsSync(existing)) { missing.unshift(basename(existing)); existing = dirname(existing); }
  assert.ok(!insideCheckout(join(realpathSync(existing), ...missing)), message);
}

/** The kit, the project the command runs in and the tools it needs; Git is the installed one, never a program of the checkout or the working directory. */
export function context({ kit = resolve(dirname(fileURLToPath(import.meta.url)), '..'), home = homedir(), log = console.log } = {}) {
  const root = projectRoot();
  const run = gitIn({}, root, kit);
  return {
    kit, root, home, log, outside: outsideCheckouts,
    git: (...args) => run(root, ...args),
    text: path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n'),
    versions: readVersions(kit),
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
      for (const [path, from] of outputs) materialize(c.root, join(c.root, path), join(next, from), c.log);
      for (const path of retire) moveAside(c.root, path, c.log);
      linkSkills(c.root, c.log);
      (c.log ?? console.log)(message);
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
 * Where a provider's installation lies and how it starts; the one place that knows (the engine installs there, the hook asks here). The provider's `install` names
 * the folder (`home` parts, `directory(version, c)`) and its start file (`launcher`); `c` needs `home`, `versions` and, for a project-bound folder, `root`.
 * `complete`: the start file exists (the folder is published whole, so a missing file means not installed).
 */
export function locate(p, c) {
  const i = p.install, directory = join(c.home, ...i.home, i.directory(c.versions[p.name], c)), entry = join(directory, i.launcher);
  return { directory, entry, complete: existsSync(entry) };
}

const unusedDays = 30;
/** "Last used" is the folder's modification time: every hook call renews it, a folder nobody uses stops being renewed. */
export function markUsed(directory) {
  try { const now = new Date(); utimesSync(directory, now, now); } catch { /* a removed or foreign folder: nothing to mark */ }
}
/** Removes the installation folders of `parent` that nobody used for `unusedDays` days, never `keep` (the one in use). Returns the removed paths. */
function pruneUnused(parent, keep) {
  const removed = [];
  for (const name of readdirSync(parent)) {
    const old = join(parent, name), entry = lstatSync(old);
    if (name.startsWith('.') || old === keep || !entry.isDirectory() || Date.now() - entry.mtimeMs < unusedDays * 86_400_000) continue;
    rmSync(old, { recursive: true, force: true });
    removed.push(old);
  }
  return removed;
}

/**
 * Installs the personal files of a provider below `home` (folder and start file: see `locate`), the wanted files
 * (`files(c, version)`: name -> { bytes } or { url, sha256 }, optional `mode`) and optional `before(c)` / `after(destination, c)` steps.
 * The folder is published whole and atomically; an existing one is only verified, never replaced. Folders unused for 30 days are removed afterwards.
 */
export async function install(p, c) {
  const i = p.install, version = c.versions[p.name];
  const destination = locate(p, c).directory, parent = dirname(destination);
  c.outside(destination, `${p.label} installation must be outside Git checkouts. Use a personal home outside any checkout before installing or enabling hooks.`);
  i.before?.(c);
  const wanted = i.files(c, version);
  mkdirSync(parent, { recursive: true });
  await guarded(parent, p.name, async () => {
    if (!existsSync(destination) || !readdirSync(destination).length) {
      // The folder of a failed download stays empty.
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
    const log = c.log ?? console.log;
    log(`${p.label} hooks installed: ${destination}`);
    markUsed(destination);
    for (const old of pruneUnused(parent, destination)) log(`${p.label} installation unused for ${unusedDays} days removed: ${old}`);
    log('Review and enable the project hooks in your agent; start a fresh session. No hook trust or personal agent settings were changed.');
  });
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  enterCwd();
  const [name, action, ...extra] = process.argv.slice(2);
  const run = { setup, install };
  const p = providerNamed(name);
  if (!p || !['setup', 'install', 'update'].includes(action) || extra.length > (action === 'update' ? 1 : 0)) {
    console.error(`Usage: node <kit>/scripts/provider.mjs [--cwd PROJECT_DIR] <${providerList().map(provider => provider.name).join('|')}> <setup|install|update [PREVIOUS_UPSTREAM_REVISION]>`);
    process.exit(2);
  }
  const c = context();
  assert.ok(action === 'setup' ? p.build : p[action], `${p.label} has no ${action}`);
  if (action === 'update') {
    assert.equal(c.root, c.kit, 'Run update inside the workflow-kit checkout');
    await p.update({ ...c, setup: () => setup(p, c) }, ...extra);
  } else await run[action](p, c);
}
