import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { run as exec } from './fixtures.mjs';

const root = process.env.WORKFLOW_KIT_TARGET || fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const git = (process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)
  .map(directory => path.join(directory, windows ? 'git.exe' : 'git')).find(existsSync);
// Deadlines only catch hung hooks; they must not measure speed on slow shared runners.
const hookTimeout = Number(process.env.WORKFLOW_KIT_HOOK_TIMEOUT_MS) || 30_000;
const version = '5.2.0-1';

test('installed hooks run every manifest command without executing checkout programs', async t => {
  assert.ok(git, 'Git must be available on an absolute PATH');
  const temp = mkdtempSync(path.join(tmpdir(), 'workflow-kit ponytail '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout with spaces');
  for (const from of ['.agents/hooks', '.agents/skills/ponytail'])
    cpSync(path.join(root, from), path.join(checkout, from), { recursive: true, dereference: true });
  mkdirSync(path.join(checkout, 'frontend'));
  assert.equal(spawnSync(git, ['init', '--quiet', checkout]).status, 0);
  const env = { ...process.env, HOME: path.join(temp, 'home'), USERPROFILE: path.join(temp, 'home'),
    XDG_CONFIG_HOME: path.join(temp, 'config'), PONYTAIL_DEFAULT_MODE: 'full' };
  const installer = fileURLToPath(new URL('../install-ponytail-hooks.mjs', import.meta.url));
  const install = (extra = {}, node = process.execPath) => spawnSync(node, [installer], { cwd: checkout, env: { ...env, ...extra }, encoding: 'utf8' });

  // The snapshot and the Node it pins stay outside Git checkouts; identical reruns are fine.
  const oldSnapshot = path.join(env.HOME, '.ponytail/workflow-kit/4.10.0-9');
  mkdirSync(oldSnapshot, { recursive: true });
  writeFileSync(path.join(oldSnapshot, 'trusted.txt'), 'Previously trusted snapshot');
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(path.join(oldSnapshot, 'trusted.txt'), 'utf8'), 'Previously trusted snapshot');
  assert.equal(install().status, 0, 'Identical reinstall');
  const linkedHome = path.join(temp, 'linked-home');
  mkdirSync(linkedHome);
  symlinkSync(checkout, path.join(linkedHome, '.ponytail'), windows ? 'junction' : 'dir');
  for (const home of [checkout, linkedHome]) assert.notEqual(install({ HOME: home, USERPROFILE: home }).status, 0, home);
  assert.equal(existsSync(path.join(checkout, '.ponytail')), false, 'Refusal precedes writes');
  const checkoutNode = path.join(checkout, 'tools', windows ? 'node.exe' : 'node');
  mkdirSync(path.dirname(checkoutNode));
  copyFileSync(process.execPath, checkoutNode);
  assert.notEqual(install({}, checkoutNode).status, 0, 'A Node inside a checkout is never pinned');
  writeFileSync(path.join(checkout, '.agents/hooks/ponytail-activate.js'), 'throw new Error("changed");\n');
  assert.notEqual(install().status, 0, 'Changed hook code needs a new snapshot version');

  // Marker programs in the checkout and on PATH (including '.') must never run.
  const marker = path.join(temp, 'hijacked'), bin = path.dirname(checkoutNode);
  const shells = windows
    ? [{ executable: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command'] }]
    : [{ executable: '/bin/sh', args: ['-c'] }];
  const gitBash = windows && path.resolve(path.dirname(git), '../bin/bash.exe');
  if (gitBash && existsSync(gitBash)) shells.push({ executable: gitBash, args: ['--noprofile', '--norc', '-c'] });
  if (windows) {
    const compiled = spawnSync(shells[0].executable, [...shells[0].args, `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:PONYTAIL_SHIM -TypeDefinition '
public class Shim { public static void Main() { System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("PONYTAIL_MARKER"), "executed"); } }'`],
    { env: { ...env, PONYTAIL_SHIM: path.join(bin, 'shim.exe') }, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    for (const directory of [bin, checkout, path.join(checkout, 'frontend')])
      for (const tool of ['node.exe', 'git.exe', 'cmd.exe', 'powershell.exe']) copyFileSync(path.join(bin, 'shim.exe'), path.join(directory, tool));
  } else {
    for (const directory of [bin, checkout, path.join(checkout, 'frontend')]) for (const tool of ['node', 'git', 'sh', 'echo'])
      writeFileSync(path.join(directory, tool), '#!/bin/sh\nprintf executed > "$PONYTAIL_MARKER"\n', { mode: 0o755 });
  }
  const hostile = { ...env, PONYTAIL_MARKER: marker, PATH: [checkout, bin, '.', process.env.PATH].join(path.delimiter) };
  const input = JSON.stringify({ prompt: '/ponytail lite' });
  const execute = (shell, command, extra = {}) => exec(shell.executable, [...shell.args, command],
    { cwd: path.join(checkout, 'frontend'), env: { ...hostile, ...extra }, input, timeout: hookTimeout });
  const manifests = ['.codex/hooks.json', '.claude/settings.json'];
  const handlers = manifest => Object.entries(JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).hooks)
    .flatMap(([event, groups]) => groups.flatMap(group => group.hooks || [group]).map(handler => ({ event, handler })))
    .filter(({ handler }) => /ponytail/.test(handler.command || ''));
  const missing = { HOME: path.join(temp, 'missing'), USERPROFILE: path.join(temp, 'missing') };
  // The handlers only read the installed snapshot, so every launcher runs side by side.
  const trials = [];
  for (const manifest of manifests) for (const { event, handler } of handlers(manifest)) {
    const start = event.toLowerCase() === 'sessionstart';
    for (const shell of shells) {
      const powershell = shell.executable.endsWith('powershell.exe');
      // Claude Code runs its hooks through Bash, also on Windows.
      if (powershell && manifest !== '.codex/hooks.json') continue;
      const command = powershell ? handler.commandWindows ?? handler.command : handler.command;
      trials.push((async () => {
        const result = await execute(shell, command);
        assert.equal(result.status, 0, `${manifest} ${event}: ${result.stderr}`);
        if (manifest !== '.claude/settings.json' && result.stdout) assert.doesNotThrow(() => JSON.parse(result.stdout), `${manifest} ${event}: host JSON`);
        // Without a snapshot only SessionStart speaks (the install hint).
        const absent = await execute(shell, command, missing);
        assert.equal(absent.status, 0, `${manifest} ${event} without snapshot: ${absent.stderr}`);
        assert.equal(Boolean(absent.stdout.trim()), start, `${manifest} ${event} without snapshot`);
      })());
    }
  }
  await Promise.all(trials);
  assert.equal(existsSync(marker), false, 'a checkout program ran');

  // A failing installed hook stays a failure through every launcher.
  const activate = path.join(env.HOME, '.ponytail/workflow-kit', version, '.agents/hooks/ponytail-activate.js');
  const [{ handler: claudeStart }] = handlers('.claude/settings.json');
  writeFileSync(activate, 'process.exit(7);');
  if (windows) assert.equal((await execute(shells[0], handlers('.codex/hooks.json')[0].handler.commandWindows)).status, 7, 'Codex preserves launcher failure');
  for (const shell of shells.filter(shell => !shell.executable.endsWith('powershell.exe')))
    assert.equal((await execute(shell, claudeStart.command)).status, 7, shell.executable);
});

test('adapted hooks preserve explicit host and checkout state and drain stdout on EOF or stuck stdin', async t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ponytail lifecycle '));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const snapshot = path.join(temp, 'snapshot'), checkout = path.join(temp, 'checkout');
  cpSync(path.join(root, '.agents/hooks'), snapshot, { recursive: true });
  mkdirSync(path.join(checkout, '.git'), { recursive: true });
  mkdirSync(path.join(checkout, 'frontend'));
  // Large rules force asynchronous pipe writes; process.exit would truncate them.
  const rules = 'x'.repeat(256 * 1024);
  writeFileSync(path.join(snapshot, 'ponytail-instructions.js'),
    `exports.getPonytailInstructions = mode => mode + ':' + ${JSON.stringify(rules)};\n`);
  const env = { ...process.env, HOME: path.join(temp, 'home'), USERPROFILE: path.join(temp, 'home'),
    XDG_CONFIG_HOME: path.join(temp, 'config'), PONYTAIL_DEFAULT_MODE: 'lite',
    PLUGIN_DATA: path.join(temp, 'inherited-codex'), COPILOT_PLUGIN_DATA: path.join(temp, 'inherited-copilot'),
    QODER_SESSION_ID: 'inherited', CURSOR_VERSION: 'inherited', ZCODE_APP_VERSION: 'inherited',
    CLAUDE_PROJECT_DIR: path.join(temp, 'inherited-project') };
  const activate = (cwd, host, extra = {}, continuation = '') => {
    const result = spawnSync(process.execPath, [path.join(snapshot, 'ponytail-activate.js'), host, continuation],
      { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: hookTimeout });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.ok(activate(checkout, 'claude') === 'lite:' + rules, 'Explicit Claude overrides inherited hosts');
  assert.ok(activate(path.join(checkout, 'frontend'), 'claude', {
    PONYTAIL_DEFAULT_MODE: 'ultra', CLAUDE_PROJECT_DIR: path.join(temp, 'other-inherited-project'),
  }, 'continue') === 'lite:' + rules, 'Resume shares canonical checkout state across subdirectories');
  assert.equal(activate(checkout, 'codex', {}, 'continue'), '', 'Other host has no mode');
  const otherCheckout = path.join(temp, 'other-checkout');
  mkdirSync(path.join(otherCheckout, '.git'), { recursive: true });
  assert.equal(activate(otherCheckout, 'claude', {}, 'continue'), '', 'Other checkout has no mode');
  for (const host of ['codex', 'claude']) {
    activate(checkout, host);
    for (const hook of ['mode-tracker', 'subagent']) for (const eof of [true, false]) {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(snapshot, `ponytail-${hook}.js`), host],
          { cwd: checkout, env: { ...env, PONYTAIL_SUBAGENT_MATCHER: '^worker$' } });
        const deadline = setTimeout(() => { child.kill(); reject(new Error(`${hook}: stdin hang`)); }, hookTimeout);
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => { clearTimeout(deadline); reject(error); });
        child.on('close', code => {
          clearTimeout(deadline);
          code === 0 ? resolve(stdout) : reject(new Error(`${hook}: ${code} ${stderr}`));
        });
        const input = JSON.stringify(hook === 'mode-tracker' ? { prompt: '/ponytail lite' } : { agentName: 'worker' });
        if (eof) child.stdin.end(input); else child.stdin.write(input);
      });
      if (host === 'codex' || hook === 'subagent') {
        const parsed = JSON.parse(output);
        assert.equal(parsed.hookSpecificOutput.hookEventName, hook === 'mode-tracker' ? 'UserPromptSubmit' : 'SubagentStart');
        if (host === 'codex') assert.ok(parsed.hookSpecificOutput.additionalContext.endsWith('lite:' + rules), `${hook} eof=${eof}: complete rules`);
        else assert.equal(parsed.hookSpecificOutput.additionalContext, 'lite:' + rules, `Claude eof=${eof}: complete subagent rules`);
      } else assert.equal(output, 'PONYTAIL MODE CHANGED — level: lite', `Claude eof=${eof}: mode confirmation only`);
    }
  }
});

test('SessionStart installs a missing snapshot on its own and the next call finds it', async t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ponytail-ensure-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout'), home = path.join(temp, 'home');
  for (const from of ['.agents/hooks', '.agents/skills/ponytail', 'scripts/impeccable'])
    cpSync(path.join(root, from), path.join(checkout, from), { recursive: true, dereference: true });
  for (const file of ['ensure-hooks', 'install-ponytail-hooks', 'install-impeccable-hooks', 'checkout-root'])
    copyFileSync(path.join(root, `scripts/${file}.mjs`), path.join(checkout, `scripts/${file}.mjs`));
  mkdirSync(path.join(checkout, '.git'));
  // The Impeccable download must fail at once here; only Ponytail is under test.
  const env = { ...process.env, HOME: home, USERPROFILE: home, IMPECCABLE_DOWNLOAD_BASE: 'http://127.0.0.1:9',
    PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter), PONYTAIL_DEFAULT_MODE: 'full' };
  const bash = windows ? ['../bin', '../../bin'].map(up => path.resolve(path.dirname(git), up, 'bash.exe')).find(existsSync) : '/bin/sh';
  const start = JSON.parse(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).hooks.SessionStart
    .flatMap(group => group.hooks).filter(handler => /ponytail|ensure-hooks/.test(handler.command));
  const ensure = start.find(handler => handler.command.includes('ensure-hooks')), activate = start.find(handler => /activate claude;/.test(handler.command));
  const call = handler => exec(bash, ['-c', handler.command], { cwd: checkout, env: { ...env, CLAUDE_PROJECT_DIR: checkout }, input: '{}', timeout: hookTimeout });
  const launcher = path.join(home, '.ponytail/workflow-kit', version, 'launch.sh');
  assert.match((await call(activate)).stdout, /Ponytail hooks are OFF/);
  assert.equal((await call(ensure)).status, 0);
  for (let wait = 0; (!existsSync(launcher) || existsSync(path.join(home, '.ponytail/workflow-kit/.install.lock'))) && wait < hookTimeout; wait += 100) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(existsSync(launcher), 'the hook started the installation, which then released its lock');
  assert.doesNotMatch((await call(activate)).stdout, /OFF/);
});

test('a removed pinned Node makes SessionStart say the hooks are off, other events stay silent', t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ponytail-stale-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout'), home = path.join(temp, 'home');
  for (const from of ['.agents/hooks', '.agents/skills/ponytail'])
    cpSync(path.join(root, from), path.join(checkout, from), { recursive: true, dereference: true });
  assert.equal(spawnSync(git, ['init', '--quiet', checkout]).status, 0);
  const node = path.join(temp, 'tools', windows ? 'node.exe' : 'node');
  mkdirSync(path.dirname(node));
  copyFileSync(process.execPath, node);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const installer = fileURLToPath(new URL('../install-ponytail-hooks.mjs', import.meta.url));
  const installed = spawnSync(node, [installer], { cwd: checkout, env, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  rmSync(node);
  const launcher = path.join(home, '.ponytail/workflow-kit', version, windows ? 'launch.cmd' : 'launch.sh');
  const launch = event => spawnSync(windows ? 'cmd.exe' : '/bin/sh', windows ? ['/c', launcher, event, 'claude'] : [launcher, event, 'claude'], { env, encoding: 'utf8' });
  const start = launch('activate');
  assert.equal(start.status, 0, start.stderr);
  assert.match(JSON.parse(start.stdout).systemMessage, /install-ponytail-hooks\.mjs/);
  const quiet = launch('subagent');
  assert.deepEqual([quiet.status, quiet.stdout.trim()], [0, '']);
});
