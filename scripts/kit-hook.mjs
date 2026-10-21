// Zweck: Eine Stelle fuer alle Kit-Hooks von Claude und Codex (gemeinsamer Kit-Checkout, Warnungen, Ponytail, Impeccable, Selbstinstallation).
// Aufruf: node scripts/kit-hook.mjs <Event> --agent <claude|codex>; Hook-JSON auf stdin, Antwort-JSON auf stdout, Exit 0.
// Nutzen: Die Agent-Einstellungen enthalten nur noch diesen Aufruf; Versionen stehen in versions.json.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const scripts = path.dirname(self);
const versions = JSON.parse(readFileSync(path.join(scripts, 'versions.json'), 'utf8'));
const windows = process.platform === 'win32';
const [event, ...rest] = process.argv.slice(2);
const agent = rest[rest.indexOf('--agent') + 1];

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

/** One installer run per machine. */
function install() {
  const home = path.join(homedir(), '.ponytail', 'workflow-kit');
  mkdirSync(home, { recursive: true });
  locked(path.join(home, '.install.lock'), 15 * 60_000, () => {
    const log = openSync(path.join(home, '.install.log'), 'w');
    try {
      // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
      for (const name of ['ponytail', 'impeccable'])
        spawnSync(process.execPath, [path.join(scripts, `install-${name}-hooks.mjs`)], { stdio: ['ignore', log, log], timeout: 300_000 });
    } finally {
      closeSync(log);
    }
  });
}

if (event === '--install') { install(); process.exit(0); }
if (!['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event) || !['claude', 'codex'].includes(agent)) {
  console.error('Usage: kit-hook.mjs <SessionStart|SubagentStart|UserPromptSubmit|PostToolUse|Stop> --agent <claude|codex>');
  process.exit(2);
}

const user = [], context = [];
const say = message => { user.push(message); context.push(message); };
if (Number(process.versions.node.split('.')[0]) < versions.node) {
  // Only SessionStart may speak: the other events do not accept this output.
  if (event === 'SessionStart') say(`Node ${versions.node} or newer is needed for the Workflow Kit hooks (found ${process.versions.node}); Ponytail, Impeccable and the kit check are off until Node is updated.`);
  emit();
  process.exit(0);
}

const git = (dir, ...args) => {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
};
const isDirectory = dir => existsSync(dir) && statSync(dir).isDirectory();
function emit() {
  if (!user.length && !context.length) return;
  const output = { systemMessage: user.join('\n'), hookSpecificOutput: { hookEventName: event, additionalContext: context.join('\n') } };
  if (!user.length) delete output.systemMessage;
  console.log(JSON.stringify(output));
}

/** Fast-forward a clean checkout to its last fetched base; a dirty one only gets a warning. No network. */
function followBase(root) {
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

const real = file => { try { return realpathSync.native(file); } catch { return ''; } };
const mentionsKit = root => ['.claude/settings.json', '.codex/hooks.json'].some(file => {
  try { return /"id":\s*"workflow-kit"/.test(readFileSync(path.join(root, file), 'utf8')); } catch { return false; }
});

/** The shared kit checkout: WORKFLOW_KIT_DIR, else `workflow-kit` next to the main checkout of the project (also from a worktree). */
function sharedKit(root) {
  if (process.env.WORKFLOW_KIT_DIR) return path.resolve(process.env.WORKFLOW_KIT_DIR);
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').out;
  return path.join(path.dirname(path.dirname(common)), 'workflow-kit');
}

let updated = false;
/** `git pull --ff-only` and the kit's own submodules, once per run. Work in progress in the checkout is never touched, only reported. */
function updateKit(kit) {
  if (updated) return;
  updated = true;
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

/** Link `.vendor/workflow-kit` of one checkout to the shared kit (a Windows junction, else a symlink), then update the kit; report what needs a human. */
function checkKit(dir, update) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok || !top.out) {
    if (isDirectory(path.join(dir, '.vendor/workflow-kit')))
      say(`${dir}: Workflow Kit not checked: git did not find the project repository (is git on PATH?).`);
    return;
  }
  const root = top.out, link = path.join(root, '.vendor/workflow-kit');
  followBase(root);
  const entry = lstatSync(link, { throwIfNoEntry: false });
  // The kit's own repository runs its own scripts; a project without any kit hook is none of our business.
  if (real(path.join(root, 'scripts/kit-hook.mjs')) === real(self) || (!entry && !mentionsKit(root))) return;
  const kit = sharedKit(root);
  if (entry && !entry.isSymbolicLink())
    return say(`${root}: .vendor/workflow-kit is still a submodule or a folder, not a link to the shared kit. Switch it: node ${path.join(kit, 'scripts/init-project.mjs')} --existing --cwd ${root}`);
  if (!existsSync(path.join(kit, 'AGENT_RULES.md')))
    return say(`${root}: the shared Workflow Kit checkout ${kit} is missing or incomplete. Clone it: git clone https://github.com/snagg-app/workflow-kit.git ${kit}`);
  if (real(link) !== real(kit)) {
    try {
      rmSync(link, { force: true });
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(kit, link, 'junction');
    } catch (error) { if (real(link) === real(kit)) return; /* a parallel session linked it first */ return say(`${root}: could not link .vendor/workflow-kit to ${kit} (${error.code ?? error.message}).`); }
  }
  if (update) updateKit(kit);
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

/** After a clean full check the git dir of the checkout gets a stamp (`kit-ok`). While project commit, kit commit and kit path are unchanged and the stamp is young,
 * the next start skips the check and the pull: one git call plus file reads. Time is only an addition, never the key. */
function checkKitStamped(dir, update) {
  const fresh = Number(process.env.KIT_HOOK_FRESH_SECONDS ?? 600) * 1000;
  const [gitDir, head] = git(dir, 'rev-parse', '--absolute-git-dir', 'HEAD').out.split('\n');
  const file = gitDir && path.join(gitDir, 'kit-ok');
  if (file) {
    try {
      const stamp = JSON.parse(readFileSync(file, 'utf8'));
      if (stamp.git === gitDir && stamp.head === head && Date.now() - stamp.at < fresh && (stamp.pulled || !update)
        && (!process.env.WORKFLOW_KIT_DIR || path.resolve(process.env.WORKFLOW_KIT_DIR) === stamp.kit) && kitHead(stamp.kit) === stamp.kitHead) return;
    } catch { /* no or broken stamp: full check */ }
  }
  const spoken = user.length, kit = checkKit(dir, update);
  if (file && kit && user.length === spoken) {
    // The check may have fast-forwarded the project, so the commit is read again.
    try { writeFileSync(file, JSON.stringify({ git: gitDir, head: git(dir, 'rev-parse', 'HEAD').out, kit, kitHead: kitHead(kit), pulled: update, at: Date.now() })); } catch { /* best effort */ }
  }
}

function checkNodeModules(dir) {
  const root = git(dir, 'rev-parse', '--show-toplevel').out;
  if (!root || isDirectory(path.join(root, 'node_modules'))) return;
  const read = file => { try { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); } catch { return null; } };
  const manifest = read('package.json');
  if (![manifest?.dependencies, manifest?.devDependencies].some(list => list && typeof list === 'object' && Object.keys(list).length)) return;
  const setup = typeof read('.github/workflow-project.json')?.setup === 'string' ? read('.github/workflow-project.json').setup.replace(/[^A-Za-z0-9 /._:=@-]/g, '') : '';
  say(`node_modules is missing in this worktree although package.json lists dependencies, so Node may resolve modules from a parent checkout. Nothing was installed: run ${setup || 'the project setup (see its AGENTS.md)'}.`);
}

/** Claude loads hooks once per session: SessionStart keeps the settings fingerprint, SubagentStart warns when the last fetched base differs. */
function fingerprint(dir, input) {
  const file = input.session_id && path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'hooks-fingerprint', path.basename(String(input.session_id)));
  if (!file) return;
  if (event === 'SubagentStart') {
    const seen = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    let now = '';
    for (const ref of ['@{upstream}', 'origin/HEAD']) if ((now = git(dir, 'rev-parse', '-q', '--verify', `${ref}:.claude/settings.json`).out)) break;
    if (seen && now && now !== seen) context.push('Hooks seit Session-Start geändert: Session neu starten');
  } else if (input.source !== 'compact') {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, git(dir, 'hash-object', path.join(dir, '.claude/settings.json')).out + '\n');
    } catch { /* best effort */ }
  }
}

/** The installed snapshots are personal and pinned to the Node that installed them, never a PATH lookup. */
function launcher(action, ...extra) {
  const file = path.join(homedir(), '.ponytail', 'workflow-kit', versions.ponytail, windows ? 'launch.cmd' : 'launch.sh');
  if (!existsSync(file)) return null;
  const args = [action, agent, ...extra];
  return windows
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], options: { windowsVerbatimArguments: true } }
    : { file: '/bin/sh', args: [file, ...args], options: {} };
}
const engine = path.join(homedir(), '.impeccable', 'workflow-kit', `engine-${versions.impeccable}`, windows ? 'impeccable.exe' : 'impeccable');

async function readInput() {
  if (process.stdin.isTTY) return '';
  return new Promise(resolve => {
    let text = '';
    const done = () => { clearTimeout(timer); process.stdin.destroy(); resolve(text); };
    // A host that leaves its pipe open must not hang the session.
    const timer = setTimeout(done, 3000);
    process.stdin.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', done).on('error', done);
  });
}

/** Run a command on the hook's own stdin/stdout: the host sees exactly what it prints and its exit code. */
function passThrough(command) {
  if (command) process.exitCode = spawnSync(command.file, command.args, { ...command.options, stdio: 'inherit', windowsHide: true }).status ?? 0;
}

if (event === 'UserPromptSubmit') passThrough(launcher('mode-tracker'));
else if (event === 'PostToolUse' || event === 'Stop') passThrough(existsSync(engine) && { file: engine, args: ['hook'], options: {} });
else {
  const raw = await readInput();
  let input = {};
  try { input = JSON.parse(raw) ?? {}; } catch { /* no hook JSON: the environment still names the project */ }
  const project = process.env.CLAUDE_PROJECT_DIR || '.';
  const fresh = !['resume', 'compact', 'fork'].includes(input.source);
  if (agent === 'claude') fingerprint(project, input);
  // A subagent in its own worktree gets CLAUDE_PROJECT_DIR of the session that started it; its own directory is the cwd on stdin.
  for (const dir of new Set([project, typeof input.cwd === 'string' && input.cwd].filter(Boolean))) checkKitStamped(dir, event === 'SessionStart' && input.source !== 'compact');
  if (event === 'SessionStart') {
    checkNodeModules(project);
    if (fresh) spawn(process.execPath, [self, '--install'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  const ponytail = launcher(event === 'SessionStart' ? 'activate' : 'subagent', ...(event === 'SessionStart' && !fresh ? ['continue'] : []));
  if (ponytail) {
    const child = spawnSync(ponytail.file, ponytail.args, { ...ponytail.options, input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    process.exitCode = child.status ?? 0;
    const text = (child.stdout ?? '').trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed.systemMessage) user.push(parsed.systemMessage);
      if (parsed.hookSpecificOutput?.additionalContext) context.push(parsed.hookSpecificOutput.additionalContext);
    } catch { if (text) context.push(text); }
  } else if (event === 'SessionStart') {
    say('Ponytail hooks are OFF. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs (maintainer pre-authorized, writes no trust).');
  }
  if (event === 'SessionStart' && fresh && !existsSync(engine))
    say('Impeccable hooks are OFF, UI checks do not run. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs (maintainer pre-authorized, writes no trust).');
  emit();
}
