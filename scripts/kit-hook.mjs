// Zweck: Eine Stelle fuer alle Kit-Hooks von Claude und Codex (gemeinsamer Kit-Checkout, Warnungen, Ponytail, Impeccable, Selbstinstallation).
// Aufruf: node scripts/kit-hook.mjs <Event> --agent <claude|codex>; Hook-JSON auf stdin, Antwort-JSON auf stdout, Exit 0.
// Nutzen: Die Agent-Einstellungen enthalten nur noch diesen Aufruf; Versionen stehen in versions.json.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents, agentNames, hookEvents } from './agents.mjs';
import { projectRoot } from './checkout-root.mjs';
import { asking, gitIn, patient } from './git-tool.mjs';
import { kitCheck, modulesCheck } from './kit-check.mjs';
import { locked } from './lock.mjs';
import { locate, markUsed } from './provider.mjs';
import impeccableProvider from './provider-impeccable.mjs';
import ponytailProvider from './provider-ponytail.mjs';
import { projectFeatures, readProfile, textsFor } from './project-profile.mjs';

const self = fileURLToPath(import.meta.url);
const scripts = path.dirname(self);
const versions = JSON.parse(readFileSync(path.join(scripts, 'versions.json'), 'utf8'));
const windows = process.platform === 'win32';
const [event, ...rest] = process.argv.slice(2);
const agent = rest[rest.indexOf('--agent') + 1];

/** The checkout both the installer and the launcher lookup read the Ponytail files from. */
const hookProject = () => projectRoot(process.env.CLAUDE_PROJECT_DIR || undefined);

/** One installer run per machine, for the functions the project uses. */
function install(names) {
  const home = path.join(homedir(), ...ponytailProvider.install.home);
  mkdirSync(home, { recursive: true });
  locked(path.join(home, '.install.lock'), 15 * 60_000, () => {
    const log = openSync(path.join(home, '.install.log'), 'w');
    try {
      // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
      for (const name of names)
        spawnSync(process.execPath, [path.join(scripts, 'provider.mjs'), name, 'install'], { cwd: hookProject(), stdio: ['ignore', log, log], timeout: 300_000 });
    } finally {
      closeSync(log);
    }
  });
}

if (event === '--install') { if (rest.length) install(rest); process.exit(0); }
if (!hookEvents.includes(event) || !agentNames.includes(agent)) {
  console.error(`Usage: kit-hook.mjs <${hookEvents.join('|')}> --agent <${agentNames.join('|')}>`);
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

// The hook runs in the project folder, so its git is looked up outside that checkout (#758).
const hookGit = gitIn(patient);
const git = asking(hookGit);
function emit() {
  if (!user.length && !context.length) return;
  const output = { systemMessage: user.join('\n'), hookSpecificOutput: { hookEventName: event, additionalContext: context.join('\n') } };
  if (!user.length) delete output.systemMessage;
  console.log(JSON.stringify(output));
}

/** Claude loads hooks once per session: SessionStart keeps the settings fingerprint, SubagentStart warns when the last fetched base differs. */
function fingerprint(dir, input, { configEnv, configDir }, settings) {
  const file = input.session_id && path.join(process.env[configEnv] || path.join(homedir(), configDir), 'hooks-fingerprint', path.basename(String(input.session_id)));
  if (!file) return;
  if (event === 'SubagentStart') {
    const seen = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    let now = '';
    for (const ref of ['@{upstream}', 'origin/HEAD']) if ((now = git(dir, 'rev-parse', '-q', '--verify', `${ref}:${settings}`).out)) break;
    if (seen && now && now !== seen) {
      let language = readProfile(dir);
      try { textsFor(language); } catch { language = {}; } // a bad profile is board.mjs's to report, not the hook's
      context.push(textsFor(language).hooksChanged);
    };
  } else if (input.source !== 'compact') {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, git(dir, 'hash-object', path.join(dir, settings)).out + '\n');
    } catch { /* best effort */ }
  }
}

/** Where a provider's installation lies (asked of the provider, never rebuilt here); a complete one is marked as used now, which keeps it from the 30-day cleanup. */
function installed(provider) {
  try {
    const where = locate(provider, { home: homedir(), versions, get root() { return hookProject(); } });
    if (!where.complete) return null;
    markUsed(where.directory);
    return where.entry;
  } catch { return null; } // e.g. committed sources missing: the same as not installed
}

/** The installed snapshots are personal and pinned to the Node that installed them, never a PATH lookup. */
function launcher(action, ...extra) {
  const file = installed(ponytailProvider);
  if (!file) return null;
  const args = [action, agent, ...extra];
  return windows
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`], options: { windowsVerbatimArguments: true } }
    : { file: '/bin/sh', args: [file, ...args], options: {} };
}
const engine = installed(impeccableProvider);

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
else if (event === 'PostToolUse' || event === 'Stop') passThrough(engine && { file: engine, args: ['hook'], options: {} });
else {
  const raw = await readInput();
  let input = {};
  try { input = JSON.parse(raw) ?? {}; } catch { /* no hook JSON: the environment still names the project */ }
  const project = process.env.CLAUDE_PROJECT_DIR || '.';
  const fresh = !['resume', 'compact', 'fork'].includes(input.source);
  const { fingerprint: where, file: settings } = agents[agent].hooks ?? {};
  if (where) fingerprint(project, input, where, settings);
  let on = { impeccable: true, ponytail: true }; // a broken profile must not stop the session
  try { on = projectFeatures(project, hookGit); } catch (error) { if (event === 'SessionStart') say(error.message); }
  // A subagent in its own worktree gets CLAUDE_PROJECT_DIR of the session that started it; its own directory is the cwd on stdin.
  for (const dir of new Set([project, typeof input.cwd === 'string' && input.cwd].filter(Boolean))) kitCheck(dir, { update: event === 'SessionStart' && input.source !== 'compact', git: hookGit }).forEach(say);
  if (event === 'SessionStart') {
    modulesCheck(project, { git: hookGit }).forEach(say);
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
  if (event === 'SessionStart' && fresh && on.impeccable && !engine)
    say('Impeccable hooks are OFF, UI checks do not run. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run node .vendor/workflow-kit/scripts/provider.mjs impeccable install (maintainer pre-authorized, writes no trust).');
  emit();
}
