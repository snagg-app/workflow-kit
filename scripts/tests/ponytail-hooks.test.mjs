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
  const temp = mkdtempSync(path.join(tmpdir(), 'vaultdex ponytail '));
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
  const oldSnapshot = path.join(env.HOME, '.ponytail/vaultdex/4.10.0-9');
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
  // Cursor on Windows pipes its payload through PowerShell's $input.
  const cursor = (shell, command) => shell.executable.endsWith('powershell.exe') ? `$input | & { $input | ${command}\n }` : command;
  const execute = (shell, command, extra = {}) => exec(shell.executable, [...shell.args, command],
    { cwd: path.join(checkout, 'frontend'), env: { ...hostile, ...extra }, input, timeout: hookTimeout });
  const manifests = ['.codex/hooks.json', '.claude/settings.json', '.github/hooks/ponytail.json', '.cursor/hooks.json'];
  const handlers = manifest => Object.entries(JSON.parse(readFileSync(path.join(root, manifest), 'utf8')).hooks)
    .flatMap(([event, groups]) => groups.flatMap(group => group.hooks || [group]).map(handler => ({ event, handler })))
    .filter(({ handler }) => /ponytail/.test(handler.command || handler.bash || ''));
  const missing = { HOME: path.join(temp, 'missing'), USERPROFILE: path.join(temp, 'missing') };
  // The handlers only read the installed snapshot, so every launcher runs side by side.
  const trials = [];
  for (const manifest of manifests) for (const { event, handler } of handlers(manifest)) {
    const start = event.toLowerCase() === 'sessionstart';
    for (const shell of shells) {
      const powershell = shell.executable.endsWith('powershell.exe');
      if (powershell && !handler.powershell && !['.codex/hooks.json', '.cursor/hooks.json'].includes(manifest)) continue;
      const native = powershell ? handler.commandWindows ?? handler.powershell ?? handler.command : handler.command ?? handler.bash;
      const command = manifest === '.cursor/hooks.json' ? cursor(shell, native) : native;
      trials.push((async () => {
        const result = await execute(shell, command);
        assert.equal(result.status, 0, `${manifest} ${event}: ${result.stderr}`);
        if (manifest !== '.claude/settings.json' && result.stdout) assert.doesNotThrow(() => JSON.parse(result.stdout), `${manifest} ${event}: host JSON`);
        // Without a snapshot only SessionStart speaks (the install hint). Cursor's prompt hook just errors.
        if (manifest === '.cursor/hooks.json' && !start) return;
        const absent = await execute(shell, command, missing);
        assert.equal(absent.status, 0, `${manifest} ${event} without snapshot: ${absent.stderr}`);
        assert.equal(Boolean(absent.stdout.trim()), start, `${manifest} ${event} without snapshot`);
      })());
    }
  }
  await Promise.all(trials);
  assert.equal(existsSync(marker), false, 'a checkout program ran');

  // A failing installed hook stays a failure through every launcher.
  const activate = path.join(env.HOME, '.ponytail/vaultdex', version, '.agents/hooks/ponytail-activate.js');
  const [{ handler: cursorStart }] = handlers('.cursor/hooks.json');
  writeFileSync(activate, 'process.exit(7);');
  if (windows) assert.equal((await execute(shells[0], handlers('.codex/hooks.json')[0].handler.commandWindows)).status, 7, 'Codex preserves launcher failure');
  for (const shell of shells) assert.equal((await execute(shell, cursor(shell, cursorStart.command))).status, 7, shell.executable);
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
  for (const host of ['codex', 'copilot']) {
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
      const parsed = JSON.parse(output);
      if (host === 'codex') {
        assert.equal(parsed.hookSpecificOutput.hookEventName, hook === 'mode-tracker' ? 'UserPromptSubmit' : 'SubagentStart');
        assert.ok(parsed.hookSpecificOutput.additionalContext.endsWith('lite:' + rules), `${hook} eof=${eof}: complete rules`);
      } else {
        assert.equal(Boolean(parsed.additionalContext), hook === 'subagent', 'Copilot receives supported subagent context');
        if (hook === 'subagent') assert.equal(parsed.additionalContext, 'lite:' + rules, `Copilot eof=${eof}: complete rules`);
      }
    }
  }
});
