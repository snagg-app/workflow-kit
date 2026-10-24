import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { usedDelta } from '../quota-sample.mjs';

const script = fileURLToPath(new URL('../quota-sample.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });

test('quota samples calculate account usage per minute and across reset', () => {
  const previous = { used: 120, resetAt: '2026-10-07T18:00:00Z' };
  assert.equal(usedDelta(undefined, previous), null);
  assert.equal(usedDelta(previous, { used: 127, resetAt: previous.resetAt }), 7);
  assert.equal(usedDelta(previous, { used: 3, resetAt: '2026-10-07T19:00:00Z' }), 3);
});

test('quota sample help exits 0 at once', () => {
  assert.equal(run('--help').status, 0);
  assert.equal(run('-h').status, 0);
});

test('quota sample refuses options as file names', () => {
  assert.notEqual(run('-').status, 0);
  assert.notEqual(run('--out.jsonl').status, 0);
  assert.notEqual(run('-x', 'extra').status, 0);
});
