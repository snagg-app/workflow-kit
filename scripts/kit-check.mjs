// Zweck: Die eine Stelle der Kit-Prüfung (Kit-Link, Kit-Stand, veralteter Branch, fehlende Abhängigkeiten): Zustand rein, Meldungen raus.
// Aufruf: import { kitCheck, modulesCheck } (Hook, board.mjs start/next) oder `node scripts/kit.mjs check` (jeder Agent, auch ohne Hooks).
// Nutzen: Der Hook ist nur eine frühere Ausführung derselben Prüfung; ein Agent ohne Hooks bekommt dieselben Hinweise über board.mjs und `kit check`.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { hookFiles } from './agents.mjs';
import { asking, gitIn, gitStamp, patient } from './git-tool.mjs';
import { sharedKit } from './kit-entry.mjs';
import { locked } from './lock.mjs';
import { readProfileLenient, textsFor } from './project-profile.mjs';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

/** The profile's texts of a project directory; English without a readable profile (a broken one is board.mjs's to report, not the check's). */
const textsAt = dir => textsFor(readProfileLenient(dir));

const isDirectory = dir => existsSync(dir) && statSync(dir).isDirectory();
const real = file => { try { return realpathSync.native(file); } catch { return ''; } };
const mentionsKit = root => hookFiles.some(file => {
  try { return /"id":\s*"workflow-kit"/.test(readFileSync(path.join(root, file), 'utf8')); } catch { return false; }
});

/** Changes in the checkout; a status that failed (timeout, git error) counts as changes, so nothing is merged on a guess. */
function dirty(git, dir) {
  const status = git(dir, '--no-optional-locks', 'status', '--porcelain', '--ignore-submodules');
  return !status.ok || status.out;
}

/** Fast-forward a clean checkout to its last fetched base; a dirty one only gets a warning. No network. */
function followBase(git, root, say) {
  for (const ref of ['@{upstream}', 'origin/HEAD']) {
    const base = git(root, 'rev-parse', '--verify', '-q', '--abbrev-ref', ref);
    if (!base.ok || !git(root, 'merge-base', '--is-ancestor', 'HEAD', base.out).ok) continue;
    const behind = Number(git(root, 'rev-list', '--count', `HEAD..${base.out}`).out);
    if (!(behind > 0)) continue;
    const name = base.out.replace(/[^A-Za-z0-9/._-]/g, '');
    if (dirty(git, root)) {
      say(textsAt(root).kitBehind(behind, name));
    } else {
      git(root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '--quiet', base.out);
    }
    return;
  }
}

/** `git pull --ff-only` and the kit's own submodules. Work in progress in the checkout is never touched, only reported. */
function updateKit(git, kit, say, root) {
  const branch = git(kit, 'symbolic-ref', '--short', '-q', 'HEAD').out;
  if (branch !== 'main')
    return say(textsAt(root).kitNotMain(kit, branch), true);
  if (dirty(git, kit) || git(kit, 'rev-list', '-n', '1', 'HEAD', '--not', '--remotes').out)
    return say(textsAt(root).kitDirty(kit), true);
  // Never prompt, never run hooks of the checkout (the runner carries the timeout and the no-prompt environment, see `hookGit`).
  const step = (...args) => git(kit, '-c', 'credential.interactive=false', '-c', 'core.hooksPath=/dev/null', ...args).ok;
  const ran = locked(path.join(git(kit, 'rev-parse', '--absolute-git-dir').out, 'kit-update.lock'), 10 * 60_000, () => {
    if (!step('pull', '--ff-only', '--quiet') || (existsSync(path.join(kit, '.gitmodules')) && !step('submodule', 'update', '--init', '--quiet')))
      say(textsAt(root).kitNotUpdated(kit), true);
  });
  // Another run holds the lock: the hook stays silent, but the kit is not known to be current (#813), so `start` stops.
  if (!ran) say(null, true);
}

/** The one repair of `.vendor/workflow-kit` (hook and `kit setup`): a link (Windows junction, else symlink) to the shared kit. Returns '' when in order, else what needs a human. */
export function linkKit(root, kit) {
  const link = path.join(root, '.vendor/workflow-kit'), entry = lstatSync(link, { throwIfNoEntry: false });
  if (entry && !entry.isSymbolicLink())
    return textsAt(root).kitFolder(root, path.join(kit, 'scripts/init-project.mjs'));
  if (!existsSync(path.join(kit, 'AGENT_RULES.md')))
    return textsAt(root).kitMissing(root, kit);
  if (real(link) === real(kit)) return '';
  try {
    rmSync(link, { force: true });
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(kit, link, 'junction');
  } catch (error) { return real(link) === real(kit) /* a parallel session linked it first */ ? '' : textsAt(root).kitLinkFailed(root, kit, error.code ?? error.message); }
  return '';
}

/** Check one checkout: link it to the shared kit, then update the kit; report what needs a human. */
function checkKit(git, dir, update, say, updated, shared) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok || !top.out) {
    if (isDirectory(path.join(dir, '.vendor/workflow-kit')))
      say(textsAt(dir).kitNoGit(dir));
    return;
  }
  const root = top.out;
  followBase(git, root, say);
  const entry = lstatSync(path.join(root, '.vendor/workflow-kit'), { throwIfNoEntry: false });
  // The kit's own repository runs its own scripts; a project without any kit hook is none of our business.
  if (real(path.join(root, 'scripts/kit-hook.mjs')) === real(path.join(scripts, 'kit-hook.mjs')) || (!entry && !mentionsKit(root))) return;
  const kit = shared ?? sharedKit(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').out), problem = linkKit(root, kit);
  if (problem) return say(problem, true);
  if (update && !updated.has(kit)) { updated.add(kit); updateKit(git, kit, (message, stuck) => { if (stuck) updated.delete(kit); say(message, stuck); }, root); } // a failed update is tried again by the next call of this process
  return kit;
}

/** Commit of the shared kit read from its files (no process); '' when unreadable, so a stamp never matches by accident. */
function kitHead(kit) {
  try {
    const gitDir = path.join(kit, '.git'), head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    try { return readFileSync(path.join(gitDir, ref), 'utf8').trim(); } catch { /* packed */ }
    return readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? '';
  } catch { return ''; }
}

/** The options the callers take from the environment: the kit checkout named by `WORKFLOW_KIT_DIR` and the stamp's lifetime in ms (`KIT_HOOK_FRESH_SECONDS`, default 10 minutes). */
export const kitEnvironment = (env = process.env) => ({
  kit: env.WORKFLOW_KIT_DIR ? path.resolve(env.WORKFLOW_KIT_DIR) : undefined,
  fresh: Number(env.KIT_HOOK_FRESH_SECONDS ?? 600) * 1000,
});

/**
 * The kit check of one directory; returns `{ messages, stuck }` (no messages: all in order). After a clean full check the git dir gets a stamp (`kit-ok`). While project commit, kit commit
 * and kit path are unchanged and the stamp is young, the next call skips the check and the pull: one git call plus file reads. Time is only an addition, never the key.
 * `stuck` (#813): the shared kit could not follow origin (not main, local work, no fast-forward); `start` refuses on it.
 * `update`: also pull the shared kit (the hook at session start); board.mjs and `kit check` read only.
 * `force`: ignore the stamp (`start` must see the real state of origin, #813).
 * `kit`: the kit checkout that runs (`kit setup`, `WORKFLOW_KIT_DIR`), instead of the shared one found next to the project.
 * `fresh`: how long a stamp counts, in ms. `updated`: kits already pulled by this process (pass one Set to several calls to pull once).
 * `git`: a runner `(dir, ...args) => output` that throws on failure (gitIn); the default is the kit's safe one, the hook and board.mjs pass theirs.
 */
export function kitCheck(dir, { update = false, force = false, git: run = gitIn(patient, dir), kit: shared, fresh = 600_000, updated = new Set() } = {}) {
  const git = asking(run), messages = [], result = { messages, stuck: false };
  const say = (message, stuck) => { if (message) messages.push(message); if (stuck) result.stuck = true; };
  const [gitDir, head] = git(dir, 'rev-parse', '--absolute-git-dir', 'HEAD').out.split('\n');
  const stamp = gitStamp(gitDir, 'kit-ok'), known = force ? null : stamp.read();
  if (known && known.git === gitDir && known.head === head && Date.now() - known.at < fresh && (known.pulled || !update)
    && (!shared || shared === known.kit) && kitHead(known.kit) === known.kitHead) return result;
  const kit = checkKit(git, dir, update, say, updated, shared);
  if (kit && !messages.length && !result.stuck)
    stamp.write({ git: gitDir, head: git(dir, 'rev-parse', 'HEAD').out, kit, kitHead: kitHead(kit), pulled: update, at: Date.now() }); // the check may have fast-forwarded the project, so the commit is read again
  return result;
}

/** A worktree without node_modules although package.json lists dependencies: Node may resolve modules from a parent checkout. */
export function modulesCheck(dir, { git: run = gitIn({}, dir) } = {}) {
  const root = asking(run)(dir, 'rev-parse', '--show-toplevel').out;
  if (!root || isDirectory(path.join(root, 'node_modules'))) return [];
  const read = file => { try { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
  const manifest = read('package.json');
  if (![manifest?.dependencies, manifest?.devDependencies].some(list => list && typeof list === 'object' && Object.keys(list).length)) return [];
  const profile = readProfileLenient(root);
  return [textsFor(profile).modulesMissing((profile.setup ?? '').replace(/[^A-Za-z0-9 /._:=@-]/g, ''))];
}
