// Zweck: Echte Hook-Kommandos auf einmaligen Setup-Hinweis und Fehlerweitergabe pruefen.
// Nutzen: Fehlende Installation verursacht keine Edit-/Stop-Schleifen; die Engine bleibt unveraendert.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporary } from './fixtures.mjs';

const kit = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const version = readFileSync(join(kit, 'scripts/impeccable/VERSION'), 'utf8').trim();
const manifests = ['.codex/hooks.json', '.claude/settings.json'];
const commands = (name, start) => Object.entries(JSON.parse(readFileSync(join(kit, 'templates', name), 'utf8')).hooks)
  .filter(([event]) => (event.toLowerCase() === 'sessionstart') === start)
  .flatMap(([, values]) => values.flatMap(group => group.hooks ?? [group]))
  .filter(hook => (hook.command ?? '').includes('.impeccable/'));
function fixture(t) {
  const root = temporary(t, 'impeccable hook ');
  return { root, env: { ...process.env, HOME: root, USERPROFILE: root } };
}
function run(hook, f, input = '{}') {
  const command = windows ? hook.commandWindows : hook.command;
  const shell = !windows ? '/bin/sh' : join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = !windows ? ['-c', command] : ['-NoProfile', '-NonInteractive', '-Command', command];
  return spawnSync(shell, args, { cwd: f.root, env: f.env, input, encoding: 'utf8', timeout: 10_000 });
}

for (const name of manifests) test(`${name}: a missing engine speaks once at SessionStart, never on edits or Stop`, {
  skip: windows && name === '.claude/settings.json' ? 'Claude runs the POSIX form through Git Bash' : false,
}, t => {
  const f = fixture(t), [start] = commands(name, true);
  const warning = run(start, f);
  assert.equal(warning.status, 0, warning.stderr);
  assert.ok(warning.stdout.trim());
  for (const hook of commands(name, false)) {
    const result = run(hook, f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, '');
  }
});

test('an installed engine receives stdin and its failure is not suppressed', t => {
  const f = fixture(t), engine = join(f.root, `.impeccable/vaultdex/engine-${version}/impeccable${windows ? '.exe' : ''}`);
  mkdirSync(join(engine, '..'), { recursive: true });
  if (windows) {
    const compiled = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:IMPECCABLE_HOOK_ENGINE -TypeDefinition '
public class Engine { public static int Main(string[] args) { if (args.Length != 1 || args[0] != "hook") return 9; System.Console.Write(System.Console.In.ReadToEnd()); return 7; } }'`],
      { env: { ...f.env, IMPECCABLE_HOOK_ENGINE: engine }, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
  } else writeFileSync(engine, '#!/bin/sh\n[ "$1" = hook ] || exit 9\nIFS= read -r event\nprintf "%s\\n" "$event"\nexit 7\n', { mode: 0o755 });
  for (const name of manifests.filter(name => !windows || name !== '.claude/settings.json')) for (const hook of commands(name, false)) {
    const result = run(hook, f, '{"hook_event_name":"Stop"}\n');
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout.trim(), '{"hook_event_name":"Stop"}');
  }
});
