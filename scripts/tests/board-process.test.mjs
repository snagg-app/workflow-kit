import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createProcess } from '../board-process.mjs';
import { temporary } from './fixtures.mjs';

test('the project setup runs with the Node that runs the board, whatever PATH says (#738)', t => {
  const cwd = temporary(t, 'board process ');
  const git = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  // A PATH without any Node: the setup would otherwise install with another Node than the agent's tests use.
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  createProcess().runShell(git, cwd, 'node -p process.execPath > node.txt', { [pathKey]: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin' });
  assert.equal(readFileSync(join(cwd, 'node.txt'), 'utf8').trim(), process.execPath);
});
