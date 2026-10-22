// Zweck: Eine Stelle fuer alle Kit-Hooks von Claude und Codex (gemeinsamer Kit-Checkout, Warnungen, Ponytail, Impeccable, Selbstinstallation).
// Aufruf: node scripts/kit-hook.mjs <Event> --agent <claude|codex>; Hook-JSON auf stdin, Antwort-JSON auf stdout, Exit 0.
// Nutzen: Die Agent-Einstellungen enthalten nur noch diesen Aufruf; Versionen stehen in versions.json.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitCheck, modulesCheck } from './kit-check.mjs';
import { projectFeatures } from './project-profile.mjs';

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

/** One installer run per machine, for the functions the project uses. */
function install(names) {
  const home = path.join(homedir(), '.ponytail', 'workflow-kit');
  mkdirSync(home, { recursive: true });
  locked(path.join(home, '.install.lock'), 15 * 60_000, () => {
    const log = openSync(path.join(home, '.install.log'), 'w');
    try {
      // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
      for (const name of names)
        spawnSync(process.execPath, [path.join(scripts, 'provider.mjs'), name, 'install'], { stdio: ['ignore', log, log], timeout: 300_000 });
    } finally {
      closeSync(log);
    }
  });
}

if (event === '--install') { if (rest.length) install(rest); process.exit(0); }
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
function emit() {
  if (!user.length && !context.length) return;
  const output = { systemMessage: user.join('\n'), hookSpecificOutput: { hookEventName: event, additionalContext: context.join('\n') } };
  if (!user.length) delete output.systemMessage;
  console.log(JSON.stringify(output));
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
  let on = { impeccable: true, ponytail: true }; // a broken profile must not stop the session
  try { on = projectFeatures(project); } catch (error) { if (event === 'SessionStart') say(error.message); }
  // A subagent in its own worktree gets CLAUDE_PROJECT_DIR of the session that started it; its own directory is the cwd on stdin.
  for (const dir of new Set([project, typeof input.cwd === 'string' && input.cwd].filter(Boolean))) kitCheck(dir, { update: event === 'SessionStart' && input.source !== 'compact' }).forEach(say);
  if (event === 'SessionStart') {
    modulesCheck(project).forEach(say);
    if (fresh) spawn(process.execPath, [self, '--install', ...Object.keys(on).filter(name => on[name])], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  const ponytail = on.ponytail && launcher(event === 'SessionStart' ? 'activate' : 'subagent', ...(event === 'SessionStart' && !fresh ? ['continue'] : []));
  if (ponytail) {
    const child = spawnSync(ponytail.file, ponytail.args, { ...ponytail.options, input: raw, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    process.exitCode = child.status ?? 0;
    const text = (child.stdout ?? '').trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed.systemMessage) user.push(parsed.systemMessage);
      if (parsed.hookSpecificOutput?.additionalContext) context.push(parsed.hookSpecificOutput.additionalContext);
    } catch { if (text) context.push(text); }
  } else if (event === 'SessionStart' && on.ponytail) {
    say('Ponytail hooks are OFF. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run node .vendor/workflow-kit/scripts/provider.mjs ponytail install (maintainer pre-authorized, writes no trust).');
  }
  if (event === 'SessionStart' && fresh && on.impeccable && !existsSync(engine))
    say('Impeccable hooks are OFF, UI checks do not run. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run node .vendor/workflow-kit/scripts/provider.mjs impeccable install (maintainer pre-authorized, writes no trust).');
  emit();
}
