import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { skipWithoutSubmodules, temporary } from './fixtures.mjs';
import { setup } from './kit-setup-fixture.mjs';

test('importing kit.mjs runs no step; kitSetup returns the result instead of exiting (#825)', { skip: skipWithoutSubmodules() }, async t => {
  const { project } = setup(t), outside = temporary(t, 'kit setup outside ');
  const { kitSetup } = await import('../kit.mjs');
  assert.equal(typeof kitSetup, 'function');
  assert.deepEqual(readdirSync(project).filter(name => name !== '.git'), [], 'the import changed nothing');
  writeFileSync(join(project, 'AGENTS.md'), 'own\n');
  symlinkSync(outside, join(project, '.github'), 'junction');
  const seen = [];
  const result = await kitSetup(project, { onStep: step => seen.push(step.title), nodeSystem: () => { throw new Error('the node step must not run before the failing step'); } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.steps.at(-1).state, 'error');
  assert.deepEqual(seen, result.steps.map(step => step.title));
  assert.deepEqual(readdirSync(outside), []);
});

test('kit setup leaves a project that is already bound to its board alone, without any network call (#730)', { skip: skipWithoutSubmodules() }, t => {
  const { project, home, run, env } = setup(t);
  mkdirSync(join(project, '.github'));
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  writeFileSync(join(project, '.github/workflow-project.json'), JSON.stringify({ language: 'en', repository: 'acme/App', owner: 'acme', number: 4, id: 'PVT_x', url: 'https://github.com/orgs/acme/projects/4' }));
  // A gh that fails loudly: any call means the board step ran.
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh called" >&2\nexit 1\n');
  writeFileSync(join(bin, 'gh.cmd'), '@echo gh called 1>&2\r\n@exit /b 1\r\n');
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', join(bin, 'gh')]);
  const result = run({ PATH: bin + (process.platform === 'win32' ? ';' : ':') + env.PATH });
  assert.match(result.stdout, /ok {4}GitHub board and labels: already bound/, result.stdout + result.stderr);
});
