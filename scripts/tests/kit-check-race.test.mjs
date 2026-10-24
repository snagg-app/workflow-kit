import assert from 'node:assert/strict';
import fs, { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { isDirectory } from '../kit-check.mjs';
import { temporary } from './fixtures.mjs';

// #991: a worktree removed between the existence check and the stat call made the Start hook crash.
// The race is reproduced by letting existsSync see the folder while statSync reports it gone.
test('isDirectory answers false instead of throwing when the folder vanishes before the stat', t => {
  const dir = join(temporary(t, 'kit-check-race '), 'worktree');
  mkdirSync(dir, { recursive: true });

  const { statSync, existsSync } = fs;
  t.after(() => { fs.statSync = statSync; fs.existsSync = existsSync; syncBuiltinESMExports(); });
  fs.existsSync = () => true;
  fs.statSync = () => { const error = new Error('ENOENT: folder removed'); error.code = 'ENOENT'; throw error; };
  syncBuiltinESMExports();

  assert.equal(isDirectory(dir), false);
});
