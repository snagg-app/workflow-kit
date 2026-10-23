// Zweck: Eine Stelle fuer alle Kit-Hooks von Claude und Codex (gemeinsamer Kit-Checkout, Warnungen, Ponytail, Impeccable, Selbstinstallation).
// Aufruf: node scripts/kit-hook.mjs <Event> --agent <claude|codex>; Hook-JSON auf stdin, Antwort-JSON auf stdout, Exit 0.
// Nutzen: Die Agent-Einstellungen enthalten nur noch diesen Aufruf; Versionen stehen im Versions-Manifest.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents, agentNames } from './agents.mjs';
import { hookEvents } from './hooks.mjs';
import { readVersions } from './versions.mjs';
import { projectRoot } from './checkout-root.mjs';
import { asking, gitIn, patient } from './git-tool.mjs';
import { kitCheck, kitEnvironment, modulesCheck } from './kit-check.mjs';
import { locate, markUsed } from './provider.mjs';
import { featureProviders, providerList, providerNamed } from './provider-list.mjs';
import { projectFeatures, readProfile, textsFor } from './project-profile.mjs';

const self = fileURLToPath(import.meta.url);
const scripts = path.dirname(self);
const versions = readVersions();
const [event, ...rest] = process.argv.slice(2);
const agent = rest[rest.indexOf('--agent') + 1];

/** The checkout both the installer and the launcher lookup read the Ponytail files from. */
const hookProject = () => projectRoot(process.env.CLAUDE_PROJECT_DIR || undefined);

const installCommand = provider => `node .vendor/workflow-kit/scripts/provider.mjs ${provider.name} install`;

/** Runs the installers for the functions the project uses; provider.mjs locks each one per machine, so two sessions install once. */
function install(names) {
  // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
  for (const name of names) {
    const home = path.join(homedir(), ...providerNamed(name).install.home);
    mkdirSync(home, { recursive: true });
    const log = openSync(path.join(home, '.install.log'), 'a');
    try {
      spawnSync(process.execPath, [path.join(scripts, 'provider.mjs'), name, 'install'], { cwd: hookProject(), stdio: ['ignore', log, log], timeout: 300_000 });
    } finally {
      closeSync(log);
    }
  }
}

if (event === '--install') { if (rest.length) install(rest); process.exit(0); }
if (!hookEvents.includes(event) || !agentNames.includes(agent)) {
  console.error(`Usage: kit-hook.mjs <${hookEvents.join('|')}> --agent <${agentNames.join('|')}>`);
  process.exit(2);
}

const user = [], context = [];
/** The hook's notices follow the language of the project profile; a bad profile is board.mjs's to report, not the hook's. */
function texts() {
  try { return textsFor(readProfile(process.env.CLAUDE_PROJECT_DIR || '.')); } catch { return textsFor({}); }
}
const say = message => { user.push(message); context.push(message); };
if (Number(process.versions.node.split('.')[0]) < versions.node) {
  // Only SessionStart may speak: the other events do not accept this output.
  if (event === 'SessionStart') say(texts().nodeOld(versions.node, process.versions.node));
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
    if (seen && now && now !== seen) context.push(texts().hooksChanged);
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

// The providers name their handlers (provider-<name>.mjs); this module only hands them what they need and dispatches.
const owners = providerList().filter(provider => provider.hooks?.[event]);
const hook = { agent, event, say, user, context, texts, installed, installCommand, passThrough };
const simple = owners.filter(provider => provider.hooks[event].kind === 'simple');
if (simple.length) simple.forEach(provider => provider.hooks[event].run(hook));
else {
  const raw = await readInput();
  let input = {};
  try { input = JSON.parse(raw) ?? {}; } catch { /* no hook JSON: the environment still names the project */ }
  const project = process.env.CLAUDE_PROJECT_DIR || '.';
  const fresh = !['resume', 'compact', 'fork'].includes(input.source);
  const { fingerprint: where, file: settings } = agents[agent].hooks ?? {};
  if (where) fingerprint(project, input, where, settings);
  let on = Object.fromEntries(featureProviders().map(provider => [provider.name, true])); // a broken profile must not stop the session
  try { on = projectFeatures(project, hookGit); } catch (error) { if (event === 'SessionStart') say(error.message); }
  // A subagent in its own worktree gets CLAUDE_PROJECT_DIR of the session that started it; its own directory is the cwd on stdin.
  const updated = new Set();
  for (const dir of new Set([project, typeof input.cwd === 'string' && input.cwd].filter(Boolean)))
    kitCheck(dir, { ...kitEnvironment(), update: event === 'SessionStart' && input.source !== 'compact', git: hookGit, updated }).messages.forEach(say);
  if (event === 'SessionStart') {
    modulesCheck(project, { git: hookGit }).forEach(say);
    if (fresh) spawn(process.execPath, [self, '--install', ...Object.keys(on).filter(name => on[name])], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  for (const provider of owners) if (on[provider.name]) provider.hooks[event].run({ ...hook, raw, fresh });
  emit();
}
