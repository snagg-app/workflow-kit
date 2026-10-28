import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { coreSkills } from '../project-profile.mjs';
import { kitCheckout, skipWithoutSubmodules, temporary } from './fixtures.mjs';

test('the project file chooses the kit skills; the project\'s own skills stay', { skip: skipWithoutSubmodules() }, t => {
  const fixture = temporary(t, 'workflow-kit choice '), scripts = join(kitCheckout(t), 'scripts');
  execFileSync('git', ['init', '--quiet', fixture]);
  const setup = () => spawnSync(process.execPath, [join(scripts, 'setup-skills.mjs')], { cwd: fixture, encoding: 'utf8' });
  const has = (provider, name) => existsSync(join(fixture, provider, 'skills', name));
  const first = setup();
  assert.equal(first.status, 0, first.stderr);
  for (const provider of ['.agents', '.claude']) {
    assert.deepEqual(coreSkills.filter(name => !has(provider, name)), [], 'the core is active without a choice');
    assert.ok(!has(provider, 'tdd') && !has(provider, 'impeccable'), provider);
  }
  mkdirSync(join(fixture, '.claude/skills/mine'), { recursive: true });
  mkdirSync(join(fixture, '.github'));
  const profile = join(fixture, '.github/workflow-project.json');
  writeFileSync(profile, JSON.stringify({ skills: ['tdd', 'ponytail'] }));
  const result = setup();
  assert.equal(result.status, 0, result.stderr);
  for (const provider of ['.agents', '.claude']) {
    assert.ok(has(provider, 'tdd') && has(provider, 'ponytail'), provider);
    assert.ok(!has(provider, 'grilling') && !has(provider, 'find-skills') && !has(provider, 'impeccable'), provider);
  }
  assert.ok(has('.claude', 'mine'), 'a skill of the project is not touched');
  writeFileSync(profile, JSON.stringify({ skills: ['core', 'tdd'] }));
  assert.equal(setup().status, 0);
  assert.ok(has('.agents', 'tdd') && has('.agents', 'grilling') && !has('.agents', 'impeccable'));
  writeFileSync(profile, JSON.stringify({ skills: 'all' }));
  assert.equal(setup().status, 0);
  assert.ok(has('.agents', 'impeccable') && has('.claude', 'tdd'));
  writeFileSync(profile, JSON.stringify({ skills: ['tdd', 'typo'] }));
  assert.notEqual(setup().status, 0);
});
