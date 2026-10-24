// Zweck: Eine Stelle für alle Kit-Hooks von Claude und Codex (gemeinsamer Kit-Checkout, Warnungen, Ponytail, Impeccable, Selbstinstallation).
// Aufruf: node scripts/kit-hook.mjs <Event> --agent <claude|codex>; Hook-JSON auf stdin, Antwort-JSON auf stdout, Exit 0.
// Nutzen: Die Agent-Einstellungen enthalten nur noch diesen Aufruf; Versionen stehen im Versions-Manifest.
// Als Funktion: `runHook({ event, agent, env, stdin })` liefert { exitCode, stdout, stderr } und beendet nichts; nur der Skript-Teil unten liest stdin, druckt und beendet den Prozess.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents, agentNames, projectDirOf } from './agents.mjs';
import { hookEvents } from './hooks.mjs';
import { readVersions } from './versions.mjs';
import { projectRoot } from './checkout-root.mjs';
import { asking, gitIn, patient } from './git-tool.mjs';
import { kitCheck, kitEnvironment, linkWorktrees, modulesCheck } from './kit-check.mjs';
import { locate, markUsed } from './provider.mjs';
import { featureProviders, providerList, providerNamed } from './provider-list.mjs';
import { projectFeatures, readProfileLenient, textsFor } from './project-profile.mjs';

const self = fileURLToPath(import.meta.url);
const scripts = path.dirname(self);
const versions = readVersions();

const installCommand = provider => `node .vendor/workflow-kit/scripts/provider.mjs ${provider.name} install`;

/** Runs the installers for the functions the project uses; provider.mjs locks each one per machine, so two sessions install once. */
function install(names, env = process.env) {
  // The installers are idempotent: a current installation is verified and left alone, a missing or stale one is replaced.
  for (const name of names) {
    const home = path.join(homedir(), ...providerNamed(name).install.home);
    mkdirSync(home, { recursive: true });
    const log = openSync(path.join(home, '.install.log'), 'a');
    try {
      spawnSync(process.execPath, [path.join(scripts, 'provider.mjs'), name, 'install'], { cwd: projectRoot(projectDirOf(undefined, env)), env, stdio: ['ignore', log, log], timeout: 300_000 });
    } finally {
      closeSync(log);
    }
  }
}

/**
 * One hook call as a function. `stdin`: the hook JSON the host sends (text). `env`: the environment the call reads (project folder, kit folder, timings).
 * `node`: the running Node version (tests lower it). Returns `{ exitCode, stdout, stderr }`; the hook's answer is the JSON line in `stdout`.
 */
export async function runHook({ event, agent, env = process.env, stdin = '', node = process.versions.node } = {}) {
  if (!hookEvents.includes(event) || !agentNames().includes(agent))
    return { exitCode: 2, stdout: '', stderr: `Usage: kit-hook.mjs <${hookEvents.join('|')}> --agent <${agentNames().join('|')}>\n` };

  const user = [], context = [], out = [], err = [];
  const hook = { exitCode: 0 };
  const result = () => {
    if (user.length || context.length) {
      const output = { systemMessage: user.join('\n'), hookSpecificOutput: { hookEventName: event, additionalContext: context.join('\n') } };
      if (!user.length) delete output.systemMessage;
      out.push(JSON.stringify(output));
    }
    return { exitCode: hook.exitCode, stdout: out.map(line => `${line}\n`).join(''), stderr: err.join('') };
  };
  /** The checkout both the installer and the launcher lookup read the Ponytail files from. */
  const hookProject = () => projectRoot(projectDirOf(undefined, env));
  /** The hook's notices follow the language of the project profile; a bad profile is board.mjs's to report, not the hook's. */
  const texts = () => textsFor(readProfileLenient(projectDirOf(agent, env) || '.'));
  const say = message => { user.push(message); context.push(message); };
  if (Number(node.split('.')[0]) < versions.node) {
    // Only SessionStart may speak: the other events do not accept this output.
    if (event === 'SessionStart') say(texts().nodeOld(versions.node, node));
    return result();
  }

  // The hook runs in the project folder, so its git is looked up outside that checkout (#758).
  const hookGit = gitIn({ ...patient, from: env });
  const git = asking(hookGit);

  /** Claude loads hooks once per session: SessionStart keeps the settings fingerprint, SubagentStart warns when the last fetched base differs. */
  function fingerprint(dir, input, { configEnv, configDir }, settings) {
    const file = input.session_id && path.join(env[configEnv] || path.join(homedir(), configDir), 'hooks-fingerprint', path.basename(String(input.session_id)));
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

  /** Run a command with the hook's input: what it prints becomes the hook's output, its status the hook's exit code. */
  function passThrough(command) {
    if (!command) return;
    const child = spawnSync(command.file, command.args, { ...command.options, input: stdin, encoding: 'utf8', env, windowsHide: true });
    if (child.stdout) out.push(child.stdout.replace(/\n$/, ''));
    if (child.stderr) err.push(child.stderr);
    hook.exitCode = child.status ?? 0;
  }

  // The providers name their handlers (provider-<name>.mjs); this module only hands them what they need and dispatches.
  const owners = providerList().filter(provider => provider.hooks?.[event]);
  Object.assign(hook, { agent, event, say, user, context, texts, installed, installCommand, passThrough });
  const simple = owners.filter(provider => provider.hooks[event].kind === 'simple');
  if (simple.length) simple.forEach(provider => provider.hooks[event].run(hook));
  else {
    let input = {};
    try { input = JSON.parse(stdin) ?? {}; } catch { /* no hook JSON: the environment still names the project */ }
    const project = projectDirOf(agent, env) || '.';
    const fresh = !['resume', 'compact', 'fork'].includes(input.source);
    const { fingerprint: where, file: settings } = agents[agent].hooks ?? {};
    if (where) fingerprint(project, input, where, settings);
    let on = Object.fromEntries(featureProviders().map(provider => [provider.name, true])); // a broken profile must not stop the session
    try { on = projectFeatures(project, hookGit); } catch (error) { if (event === 'SessionStart') say(error.message); }
    // A subagent in its own worktree gets the project variable of the session that started it; its own directory is the cwd on stdin.
    const updated = new Set();
    for (const dir of new Set([project, typeof input.cwd === 'string' && input.cwd].filter(Boolean)))
      kitCheck(dir, { ...kitEnvironment(env), update: event === 'SessionStart' && input.source !== 'compact', git: hookGit, updated }).messages.forEach(say);
    // #863: the hook's cwd is the parent's, so a subagent's fresh worktree is found through the project's worktree list.
    linkWorktrees(project, { ...kitEnvironment(env), git: hookGit }).forEach(say);
    if (event === 'SessionStart') {
      modulesCheck(project, { git: hookGit }).forEach(say);
      if (fresh) spawn(process.execPath, [self, '--install', ...Object.keys(on).filter(name => on[name])], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
    }
    Object.assign(hook, { raw: stdin, fresh }); // the providers set hook.exitCode, so they get this object, not a copy
    for (const provider of owners) if (on[provider.name]) provider.hooks[event].run(hook);
  }
  return result();
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

// Script part: the only place that reads stdin, prints and ends the process.
if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(self)) {
  const [event, ...rest] = process.argv.slice(2);
  if (event === '--install') { if (rest.length) install(rest); process.exit(0); }
  const agent = rest[rest.indexOf('--agent') + 1];
  const { exitCode, stdout, stderr } = await runHook({ event, agent, stdin: await readInput() });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = exitCode; // not process.exit: a pipe may still hold the output
}
