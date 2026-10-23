// Zweck: Die eine Stelle der Kit-Prüfung (Kit-Link, Kit-Stand, veralteter Branch, fehlende Abhängigkeiten): Zustand rein, Meldungen raus.
// Aufruf: import { kitCheck, modulesCheck } (Hook, board.mjs start/next) oder `node scripts/kit.mjs check` (jeder Agent, auch ohne Hooks).
// Nutzen: Der Hook ist nur eine frühere Ausführung derselben Prüfung; ein Agent ohne Hooks bekommt dieselben Hinweise über board.mjs und `kit check`.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hookFiles } from './agents.mjs';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));

/** Runs `work` under an atomic lock directory; a holder that crashed is taken over after `stale` ms. Another live holder: skipped, not waited for. */
function locked(lock, stale, work) {
  for (let attempt = 0;; attempt++) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST' || attempt || Date.now() - statSync(lock).mtimeMs < stale) return;
      rmSync(lock, { recursive: true, force: true });
    }
  }
  try { work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

const processGit = (dir, ...args) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
};
/** The git of the running check: the process's own, or the runner a caller injects (board.mjs finds git by its own rules and its tests fake it). */
let git = processGit;
const useGit = run => { git = run ? (_dir, ...args) => { try { return { ok: true, out: run(...args) }; } catch { return { ok: false, out: '' }; } } : processGit; };
const isDirectory = dir => existsSync(dir) && statSync(dir).isDirectory();
const real = file => { try { return realpathSync.native(file); } catch { return ''; } };
const mentionsKit = root => hookFiles.some(file => {
  try { return /"id":\s*"workflow-kit"/.test(readFileSync(path.join(root, file), 'utf8')); } catch { return false; }
});

/** Fast-forward a clean checkout to its last fetched base; a dirty one only gets a warning. No network. */
function followBase(root, say) {
  for (const ref of ['@{upstream}', 'origin/HEAD']) {
    const base = git(root, 'rev-parse', '--verify', '-q', '--abbrev-ref', ref);
    if (!base.ok || !git(root, 'merge-base', '--is-ancestor', 'HEAD', base.out).ok) continue;
    const behind = Number(git(root, 'rev-list', '--count', `HEAD..${base.out}`).out);
    if (!(behind > 0)) continue;
    const name = base.out.replace(/[^A-Za-z0-9/._-]/g, '');
    if (git(root, '--no-optional-locks', 'status', '--porcelain', '--ignore-submodules').out) {
      say(`Checkout is ${behind} commit(s) behind ${name} (as of the last fetch) and has no commits of its own but local changes, so it was not fast-forwarded and its rules, skills and board commands may be outdated. Nothing was fetched: commit or stash the changes, run git fetch, then git merge --ff-only ${name}; skills load at session start, so restart after updating.`);
    } else {
      git(root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '--quiet', base.out);
    }
    return;
  }
}

/** The shared kit checkout: WORKFLOW_KIT_DIR, else `workflow-kit` next to the main checkout of the project (also from a worktree). */
function sharedKit(root) {
  if (process.env.WORKFLOW_KIT_DIR) return path.resolve(process.env.WORKFLOW_KIT_DIR);
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').out;
  return path.join(path.dirname(path.dirname(common)), 'workflow-kit');
}

/** `git pull --ff-only` and the kit's own submodules. Work in progress in the checkout is never touched, only reported. */
function updateKit(kit, say) {
  const branch = git(kit, 'symbolic-ref', '--short', '-q', 'HEAD').out;
  if (branch !== 'main')
    return say(`The shared Workflow Kit checkout ${kit} is ${branch ? `on branch ${branch}` : 'on a fixed revision'}, not on main, so it was not updated. When you are done with it: git -C ${kit} switch main`);
  if (git(kit, '--no-optional-locks', 'status', '--porcelain', '--ignore-submodules').out || git(kit, 'rev-list', '-n', '1', 'HEAD', '--not', '--remotes').out)
    return say(`The shared Workflow Kit checkout ${kit} has local changes or unpublished commits, so it was not updated. Kit work belongs in its own worktree of the kit repository: resolve them in ${kit}.`);
  // Never prompt, never run hooks of the checkout, never wait long: the host kills the whole hook after 120 seconds.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' };
  const step = (...args) => spawnSync('git', ['-C', kit, '-c', 'credential.interactive=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { stdio: 'ignore', windowsHide: true, env, timeout: 40_000 }).status === 0;
  locked(path.join(git(kit, 'rev-parse', '--absolute-git-dir').out, 'kit-update.lock'), 10 * 60_000, () => {
    if (!step('pull', '--ff-only', '--quiet') || (existsSync(path.join(kit, '.gitmodules')) && !step('submodule', 'update', '--init', '--quiet')))
      say(`The shared Workflow Kit checkout ${kit} could not be updated (offline or diverged?). Try: git -C ${kit} pull --ff-only && git -C ${kit} submodule update --init`);
  });
}

/** The one repair of `.vendor/workflow-kit` (hook and `kit setup`): a link (Windows junction, else symlink) to the shared kit. Returns '' when in order, else what needs a human. */
export function linkKit(root, kit) {
  const link = path.join(root, '.vendor/workflow-kit'), entry = lstatSync(link, { throwIfNoEntry: false });
  if (entry && !entry.isSymbolicLink())
    return `${root}: .vendor/workflow-kit is a folder or submodule, not a link to the shared kit. Delete it (git rm -f for a submodule), then: node ${path.join(kit, 'scripts/init-project.mjs')} --existing --cwd ${root}`;
  if (!existsSync(path.join(kit, 'AGENT_RULES.md')))
    return `${root}: the shared Workflow Kit checkout ${kit} is missing or incomplete. Clone it: git clone https://github.com/snagg-app/workflow-kit.git ${kit}`;
  if (real(link) === real(kit)) return '';
  try {
    rmSync(link, { force: true });
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(kit, link, 'junction');
  } catch (error) { return real(link) === real(kit) /* a parallel session linked it first */ ? '' : `${root}: could not link .vendor/workflow-kit to ${kit} (${error.code ?? error.message}).`; }
  return '';
}

/** Check one checkout: link it to the shared kit, then update the kit; report what needs a human. */
function checkKit(dir, update, say, state, shared) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok || !top.out) {
    if (isDirectory(path.join(dir, '.vendor/workflow-kit')))
      say(`${dir}: Workflow Kit not checked: git did not find the project repository (is git on PATH?).`);
    return;
  }
  const root = top.out;
  followBase(root, say);
  const entry = lstatSync(path.join(root, '.vendor/workflow-kit'), { throwIfNoEntry: false });
  // The kit's own repository runs its own scripts; a project without any kit hook is none of our business.
  if (real(path.join(root, 'scripts/kit-hook.mjs')) === real(path.join(scripts, 'kit-hook.mjs')) || (!entry && !mentionsKit(root))) return;
  const kit = shared ?? sharedKit(root), problem = linkKit(root, kit);
  if (problem) return say(problem);
  if (update && !state.updated) { state.updated = true; updateKit(kit, say); }
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
 * `git`: a runner `(...args) => output` in `dir` that throws on failure (board.mjs injects its own).
 */
export function kitCheck(dir, { update = false, git: run, kit: shared } = {}) {
  useGit(run);
  const messages = [], say = message => messages.push(message);
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
  const kit = checkKit(dir, update, say, state, shared);
  if (file && kit && !messages.length) {
    // The check may have fast-forwarded the project, so the commit is read again.
    try { writeFileSync(file, JSON.stringify({ git: gitDir, head: git(dir, 'rev-parse', 'HEAD').out, kit, kitHead: kitHead(kit), pulled: update, at: Date.now() })); } catch { /* best effort */ }
  }
  return messages;
}

/** A worktree without node_modules although package.json lists dependencies: Node may resolve modules from a parent checkout. */
export function modulesCheck(dir, { git: run } = {}) {
  useGit(run);
  const root = git(dir, 'rev-parse', '--show-toplevel').out;
  if (!root || isDirectory(path.join(root, 'node_modules'))) return [];
  const read = file => { try { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
  const manifest = read('package.json');
  if (![manifest?.dependencies, manifest?.devDependencies].some(list => list && typeof list === 'object' && Object.keys(list).length)) return [];
  const setup = typeof read('.github/workflow-project.json')?.setup === 'string' ? read('.github/workflow-project.json').setup.replace(/[^A-Za-z0-9 /._:=@-]/g, '') : '';
  return [`node_modules is missing in this worktree although package.json lists dependencies, so Node may resolve modules from a parent checkout. Nothing was installed: run ${setup || 'the project setup (see its AGENTS.md)'}.`];
}
