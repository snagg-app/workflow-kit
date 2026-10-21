// Zweck: Den Hook-Einstieg fuer Edit- und Stop-Ereignisse auf Stille ohne Engine und Fehlerweitergabe mit Engine pruefen.
// Nutzen: Fehlende Installation verursacht keine Edit-/Stop-Schleifen; die Engine bleibt unveraendert.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporary } from './fixtures.mjs';

const hook = fileURLToPath(new URL('../kit-hook.mjs', import.meta.url));
const windows = process.platform === 'win32';
const { impeccable: version } = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url), 'utf8'));
const agents = ['claude', 'codex'], events = ['PostToolUse', 'Stop'];
function fixture(t) {
  const root = temporary(t, 'impeccable hook ');
  return { root, env: { ...process.env, HOME: root, USERPROFILE: root } };
}
const run = (event, agent, f, input = '{}') => spawnSync(process.execPath, [hook, event, '--agent', agent], { cwd: f.root, env: f.env, input, encoding: 'utf8', timeout: 10_000 });

test('a missing engine keeps edits and Stop silent', t => {
  const f = fixture(t);
  for (const agent of agents) for (const event of events) {
    const result = run(event, agent, f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, '');
  }
});

test('an installed engine receives stdin and its failure is not suppressed', t => {
  const f = fixture(t), engine = join(f.root, `.impeccable/workflow-kit/engine-${version}/impeccable${windows ? '.exe' : ''}`);
  mkdirSync(join(engine, '..'), { recursive: true });
  if (windows) {
    const compiled = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -OutputType ConsoleApplication -OutputAssembly $env:IMPECCABLE_HOOK_ENGINE -TypeDefinition '
public class Engine { public static int Main(string[] args) { if (args.Length != 1 || args[0] != "hook") return 9; System.Console.Write(System.Console.In.ReadToEnd()); return 7; } }'`],
      { env: { ...f.env, IMPECCABLE_HOOK_ENGINE: engine }, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
  } else writeFileSync(engine, '#!/bin/sh\n[ "$1" = hook ] || exit 9\nIFS= read -r event\nprintf "%s\\n" "$event"\nexit 7\n', { mode: 0o755 });
  for (const agent of agents) for (const event of events) {
    const result = run(event, agent, f, '{"hook_event_name":"Stop"}\n');
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout.trim(), '{"hook_event_name":"Stop"}');
  }
});
