// Zweck: Jedes Kit-Skript startet auch ueber einen Link (.vendor/workflow-kit ist einer) und bei anderer Schreibweise unter Windows.
// Nutzen: Ein Skript, das ueber den Link still nichts tut, faellt hier auf, nicht erst im Projekt.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMain } from '../is-main.mjs';
import { temporary } from './fixtures.mjs';

const scripts = fileURLToPath(new URL('..', import.meta.url));
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });

test('kit scripts run when started through a link to the kit', t => {
  const link = join(temporary(t, 'is-main link '), 'kit-scripts');
  symlinkSync(scripts, link, process.platform === 'win32' ? 'junction' : 'dir');
  const quota = run(join(link, 'quota-sample.mjs'), '--help');
  assert.equal(quota.status, 0);
  assert.ok(quota.stdout.trim().length > 0, 'the usage text proves the entry point ran, not a silent exit 0');
  assert.equal(run(join(link, 'provider.mjs')).status, 2);
});

test('isMain compares real paths, ignoring Windows casing and backslashes', { skip: process.platform !== 'win32' }, () => {
  const file = fileURLToPath(new URL('../quota-sample.mjs', import.meta.url));
  assert.ok(isMain(new URL('../quota-sample.mjs', import.meta.url).href, file.toUpperCase().replaceAll('/', '\\')));
  assert.ok(!isMain(new URL('../quota-sample.mjs', import.meta.url).href, fileURLToPath(import.meta.url)));
  assert.ok(!isMain(import.meta.url, ''));
});
