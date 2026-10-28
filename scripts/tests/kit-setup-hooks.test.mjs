import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { skipWithoutSubmodules } from './fixtures.mjs';
import { setup } from './kit-setup-fixture.mjs';

test('kit setup keeps the own hooks, settings and AGENTS.md of an existing project', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t);
  mkdirSync(join(project, '.claude'));
  const own = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ id: 'mine', type: 'command', command: 'echo mine' }] }] } };
  writeFileSync(join(project, '.claude/settings.json'), JSON.stringify(own));
  writeFileSync(join(project, 'AGENTS.md'), 'my rules\n');
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const settings = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, own.permissions);
  assert.ok(settings.hooks.Stop.some(group => group.hooks.some(handler => handler.id === 'mine')));
  assert.ok(settings.hooks.SessionStart.some(group => group.hooks.some(handler => handler.id === 'workflow-kit')));
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'my rules\n');
  assert.equal(existsSync(join(project, 'CONTRIBUTING.md')), false, 'an existing project gets no starter files');});

test('kit setup lists the git hooks as open when a foreign core.hooksPath blocks them (#1026)', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t);
  mkdirSync(join(project, '.githooks'));
  writeFileSync(join(project, '.githooks/pre-push'), '#!/bin/sh\n');
  execFileSync('git', ['-C', project, 'config', '--local', 'core.hooksPath', '.husky']);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /open {2}git hooks \(\.githooks\)/, result.stdout);
  assert.match(result.stdout, /Only you can do:[\s\S]*Fix "git hooks \(\.githooks\)"/, result.stdout);
});

test('kit setup leaves a committed hook entry file as it is and says so once (#985)', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t);
  mkdirSync(join(project, '.agents'));
  writeFileSync(join(project, '.agents/workflow-kit-hook.mjs'), '// older kit\n');
  execFileSync('git', ['-C', project, 'add', '.agents/workflow-kit-hook.mjs']);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(project, '.agents/workflow-kit-hook.mjs'), 'utf8'), '// older kit\n');
  assert.equal(result.stdout.match(/Kept \d+ committed kit file/g)?.length, 1, result.stdout);
});
