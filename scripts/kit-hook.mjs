// Zweck: Eine Stelle fuer alle Kit-Hooks von Claude und Codex (Kit-Pin, Warnungen, Ponytail, Impeccable, Selbstinstallation).
// Aufruf: node scripts/kit-hook.mjs <Event> --agent <claude|codex>; Hook-JSON auf stdin, Antwort-JSON auf stdout, Exit 0.
// Nutzen: Die Agent-Einstellungen enthalten nur noch diesen Aufruf; Versionen stehen in versions.json.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const scripts = path.dirname(self);
const versions = JSON.parse(readFileSync(path.join(scripts, 'versions.json'), 'utf8'));
const windows = process.platform === 'win32';
const [event, ...rest] = process.argv.slice(2);
const agent = rest[rest.indexOf('--agent') + 1];

/** One installer run per machine: the lock directory is atomic; a crashed run is taken over after 15 minutes. */
function install() {
  const home = path.join(homedir(), '.ponytail', 'workflow-kit');
  const lock = path.join(home, '.install.lock');
  mkdirSync(home, { recursive: true });
  for (let attempt = 0;; attempt++) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST' || attempt || Date.now() - statSync(lock).mtimeMs < 15 * 60_000) return;
      rmSync(lock, { recursive: true, force: true });
    }
  }
  const log = openSync(path.join(home, '.install.log'), 'w');
  try {
    // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
    for (const name of ['ponytail', 'impeccable'])
      spawnSync(process.execPath, [path.join(scripts, `install-${name}-hooks.mjs`)], { stdio: ['ignore', log, log], timeout: 300_000 });
  } finally {
    closeSync(log);
    rmSync(lock, { recursive: true, force: true });
  }
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
function followBase(root, kit) {
  for (const ref of ['@{upstream}', 'origin/HEAD']) {
    const base = git(root, 'rev-parse', '--verify', '-q', '--abbrev-ref', ref);
    if (!base.ok || !git(root, 'merge-base', '--is-ancestor', 'HEAD', base.out).ok) continue;
    const behind = Number(git(root, 'rev-list', '--count', `HEAD..${base.out}`).out);
    if (!(behind > 0)) continue;
    const name = base.out.replace(/[^A-Za-z0-9/._-]/g, '');
    if (git(root, '--no-optional-locks', 'status', '--porcelain', '--ignore-submodules').out) {
      say(`Checkout is ${behind} commit(s) behind ${name} (as of the last fetch) and has no commits of its own but local changes, so it was not fast-forwarded and its rules, skills and board commands may be outdated. Nothing was fetched: commit or stash the changes, run git fetch, then git merge --ff-only ${name}; skills load at session start, so restart after updating.`);
    } else {
      // A kit on its own branch keeps it: the project moves, the kit does not follow.
      const branched = existsSync(path.join(kit, '.git')) && git(kit, 'symbolic-ref', '-q', 'HEAD').ok;
      git(root, '-c', 'core.hooksPath=/dev/null', ...(branched ? ['-c', 'submodule.recurse=false'] : []), 'merge', '--ff-only', '--quiet', base.out);
    }
    return;
  }
}

/** Bring the kit of one checkout to the commit the project pins; report what needs a human. */
function checkKit(dir) {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  if (!top.ok || !top.out) {
    if (isDirectory(path.join(dir, '.vendor/workflow-kit')))
      say(`${dir}: Workflow Kit not checked: git did not find the project repository (is git on PATH?). From that directory run git submodule update --init .vendor/workflow-kit`);
    return;
  }
  const root = top.out, kit = path.join(root, '.vendor/workflow-kit');
  followBase(root, kit);
  const [mode, pin] = git(root, 'ls-files', '-s', '--', '.vendor/workflow-kit').out.split(/\s+/);
  if (mode !== '160000') return;
  const current = () => git(kit, 'rev-parse', 'HEAD').out === pin && existsSync(path.join(kit, 'AGENT_RULES.md'));
  if (current()) return;
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir').out;
  // Remnants of an aborted first clone: empty folders only (rmdir never removes content).
  for (const part of ['modules/.vendor/workflow-kit', 'modules/.vendor', 'modules']) try { rmdirSync(path.join(gitDir, part)); } catch { /* not empty or absent */ }
  const dot = path.join(kit, '.git');
  if (existsSync(dot) && statSync(dot).isFile() && !git(kit, 'rev-parse', '--git-dir').ok) {
    if (readdirSync(kit).length === 1) rmSync(dot, { force: true });
    else return say(`${root}: Workflow Kit has a .git that points nowhere and other files, so it was not repaired: if they are not needed, from that directory run rm -rf .vendor/workflow-kit && git submodule update --init .vendor/workflow-kit`);
  }
  if (existsSync(dot) && (git(kit, 'status', '--porcelain', '--ignored', '--untracked-files=all').out
    || git(kit, 'rev-list', '-n', '1', 'HEAD', '--not', '--remotes').out || git(kit, 'symbolic-ref', '-q', 'HEAD').ok))
    return say(`${root}: Workflow Kit is not at the commit this project pins, but it has local changes, unpublished commits or a checked-out branch, so it was not updated: resolve them, then from that directory run git submodule update --init .vendor/workflow-kit`);
  // Never prompt, never run hooks of the checkout.
  spawnSync('git', ['-C', root, '-c', 'credential.interactive=false', '-c', 'core.hooksPath=/dev/null', 'submodule', 'update', '--init', '--checkout', '.vendor/workflow-kit'],
    { stdio: 'ignore', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', SSH_ASKPASS: 'true' } });
  if (!current()) say(`${root}: Workflow Kit missing, incomplete or not at the commit this project pins: from that directory run git submodule update --init .vendor/workflow-kit (still missing: git -C .vendor/workflow-kit checkout -- AGENT_RULES.md)`);
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
  for (const dir of new Set([project, typeof input.cwd === 'string' && input.cwd].filter(Boolean))) checkKit(dir);
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
