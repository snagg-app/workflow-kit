import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { temporary } from './fixtures.mjs';

const script = fileURLToPath(new URL('../setup-github.mjs', import.meta.url));
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('outside a Git checkout the script stops with exit 2 and writes nothing (#920)', t => {
  const folder = temporary(t, 'setup github ');
  assert.equal(run(folder, 'acme/app').status, 2);
  assert.equal(existsSync(join(folder, '.github')), false);
});

test('--help exits 0, an unknown option exits 2 (#920)', t => {
  const folder = temporary(t, 'setup github ');
  assert.equal(run(folder, '--help').status, 0);
  assert.equal(run(folder, '--bogus', 'acme/app').status, 2);
});
