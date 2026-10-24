import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHook } from '../kit-hook.mjs';
import { nodeTooOld, readVersions } from '../versions.mjs';

test('runHook: a bad call returns exit code 2 and a usage line instead of ending the process', async () => {
  const result = await runHook({ event: 'Nope', agent: 'claude' });
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr);
  assert.equal(result.stdout, '');
});

test('runHook: with a too old Node (22) only SessionStart answers and names the needed version', async () => {
  const { node: needed } = readVersions();
  const start = await runHook({ event: 'SessionStart', agent: 'claude', node: '22.0.0', env: {} });
  assert.equal(start.exitCode, 0);
  const text = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.ok(text.includes(String(needed)) && text.includes('22.0.0'));
  assert.deepEqual(await runHook({ event: 'UserPromptSubmit', agent: 'claude', node: '22.0.0', env: {} }), { exitCode: 0, stdout: '', stderr: '' });
});

test('nodeTooOld: names needed and found version, empty when new enough', () => {
  assert.equal(nodeTooOld('22.1.0', 24), 'Node 24 oder neuer nötig, gefunden: 22.1.0');
  assert.equal(nodeTooOld('24.0.0', 24), '');
});

test('versions.json requires the Node that RegExp.escape needs', () => {
  assert.ok(readVersions().node >= 24);
});
