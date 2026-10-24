import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGithub } from '../github.mjs';

// A `gh` stand-in that hangs: node preloads a script that blocks for 20 s before it would look at its arguments.
test('a hanging gh call ends with a clear timeout error instead of waiting forever', () => {
  const hang = join(mkdtempSync(join(tmpdir(), 'gh-timeout-')), 'hang.cjs');
  writeFileSync(hang, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);\n');
  const tool = { file: process.execPath, env: { ...process.env, NODE_OPTIONS: `--require=${hang.replaceAll('\\', '/')}` } };
  const github = createGithub({ tool, projectDirectory: '.', sleep() {}, timeoutMs: 300 });
  const started = Date.now();
  assert.throws(() => github.rest('repos/o/r/pulls/1'), /gh api repos\/o\/r\/pulls\/1 .*within 0\.3 s/);
  assert.ok(Date.now() - started < 10_000, 'the call was cut off by the time limit');
});
