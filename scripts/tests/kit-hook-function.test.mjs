import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHook } from '../kit-hook.mjs';

test('runHook: a bad call returns exit code 2 and a usage line instead of ending the process', async () => {
  const result = await runHook({ event: 'Nope', agent: 'claude' });
  assert.equal(result.exitCode, 2);
  assert.ok(result.stderr);
  assert.equal(result.stdout, '');
});

test('runHook: with a too old Node only SessionStart answers, as one JSON line', async () => {
  const start = await runHook({ event: 'SessionStart', agent: 'claude', node: '1.0.0', env: {} });
  assert.equal(start.exitCode, 0);
  assert.ok(JSON.parse(start.stdout).hookSpecificOutput.additionalContext);
  assert.deepEqual(await runHook({ event: 'UserPromptSubmit', agent: 'claude', node: '1.0.0', env: {} }), { exitCode: 0, stdout: '', stderr: '' });
});
