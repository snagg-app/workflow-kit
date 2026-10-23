// Zweck: Die eine Stelle der Kit-Prüfung (Kit-Link, Kit-Stand, veralteter Branch, fehlende Abhängigkeiten): Zustand rein, Meldungen raus.
// Aufruf: import { kitCheck, modulesCheck } (Hook, board.mjs start/next) oder `node scripts/kit.mjs check` (jeder Agent, auch ohne Hooks).
// Nutzen: Der Hook ist nur eine frühere Ausführung derselben Prüfung; ein Agent ohne Hooks bekommt dieselben Hinweise über board.mjs und `kit check`.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hookFiles } from './agents.mjs';
import { asking, gitIn, patient } from './git-tool.mjs';
import { sharedKit } from './kit-entry.mjs';
import { locked } from './lock.mjs';
import { readProfile, textsFor } from './project-profile.mjs';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

/** The profile's texts of a project directory; English without a readable profile (a broken one is board.mjs's to report, not the check's). */
function textsAt(dir) {
  try { return textsFor(readProfile(dir)); } catch { return textsFor({}); }
}

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
  locked(path.join(git(kit, 'rev-parse', '--absolute-git-dir').out, 'kit-update.lock'), 10 * 60_000, () => {
    if (!step('pull', '--ff-only', '--quiet') || (existsSync(path.join(kit, '.gitmodules')) && !step('submodule', 'update', '--init', '--quiet')))
      say(textsAt(root).kitNotUpdated(kit), true);
  });
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
function checkKit(git, dir, update, say, state, shared) {
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
  if (problem) return say(problem);
  if (update && !state.updated) { state.updated = true; updateKit(git, kit, say, root); }
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

const state = { updated: false };

/**
 * The kit check of one directory; returns the messages (empty: all in order). After a clean full check the git dir gets a stamp (`kit-ok`). While project commit, kit commit
 * and kit path are unchanged and the stamp is young, the next call skips the check and the pull: one git call plus file reads. Time is only an addition, never the key.
 * `update`: also pull the shared kit (the hook at session start); board.mjs and `kit check` read only.
 * `kit`: the kit checkout that runs (`kit setup`), instead of the shared one found next to the project.
 * `git`: a runner `(dir, ...args) => output` that throws on failure (gitIn); the default is the kit's safe one, the hook and board.mjs pass theirs.
 */
export function kitCheck(dir, { update = false, git: run = gitIn(patient, dir), kit: shared } = {}) {
  // `messages.stuck` (#813): the shared kit could not follow origin (not main, local work, no fast-forward); `start` refuses on it.
  const git = asking(run), messages = [], say = (message, stuck) => { messages.push(message); if (stuck) messages.stuck = true; };
  const fresh = Number(process.env.KIT_HOOK_FRESH_SECONDS ?? 600) * 1000;
  const [gitDir, head] = git(dir, 'rev-parse', '--absolute-git-dir', 'HEAD').out.split('\n');
  const file = gitDir && path.join(gitDir, 'kit-ok');
  if (file) {
    try {
      const stamp = JSON.parse(readFileSync(file, 'utf8'));
      if (stamp.git === gitDir && stamp.head === head && Date.now() - stamp.at < fresh && (stamp.pulled || !update)
        && (!process.env.WORKFLOW_KIT_DIR || path.resolve(process.env.WORKFLOW_KIT_DIR) === stamp.kit) && (!shared || shared === stamp.kit) && kitHead(stamp.kit) === stamp.kitHead) return messages;
    } catch { /* no or broken stamp: full check */ }
  }
  const kit = checkKit(git, dir, update, say, state, shared);
  if (messages.stuck) state.updated = false; // a failed update is tried again by the next call of this process
  if (file && kit && !messages.length) {
    // The check may have fast-forwarded the project, so the commit is read again.
    try { writeFileSync(file, JSON.stringify({ git: gitDir, head: git(dir, 'rev-parse', 'HEAD').out, kit, kitHead: kitHead(kit), pulled: update, at: Date.now() })); } catch { /* best effort */ }
  }
  return messages;
}

/** A worktree without node_modules although package.json lists dependencies: Node may resolve modules from a parent checkout. */
export function modulesCheck(dir, { git: run = gitIn({}, dir) } = {}) {
  const root = asking(run)(dir, 'rev-parse', '--show-toplevel').out;
  if (!root || isDirectory(path.join(root, 'node_modules'))) return [];
  const read = file => { try { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
  const manifest = read('package.json');
  if (![manifest?.dependencies, manifest?.devDependencies].some(list => list && typeof list === 'object' && Object.keys(list).length)) return [];
  let setup = '';
  try { setup = readProfile(root).setup.replace(/[^A-Za-z0-9 /._:=@-]/g, ''); } catch { /* a broken profile is board.mjs's to report, not the hook's */ }
  return [textsAt(root).modulesMissing(setup)];
}
