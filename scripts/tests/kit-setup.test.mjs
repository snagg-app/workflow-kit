import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { statusMismatch } from '../project-profile.mjs';
import { skipWithoutSubmodules, temporary } from './fixtures.mjs';
import { setup, snapshot } from './kit-setup-fixture.mjs';

test('kit setup sets up an empty project and a second run changes nothing', { skip: skipWithoutSubmodules() }, t => {
  const { project, home, run } = setup(t);
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Only you can do:/);
  assert.match(first.stdout, /No agent found in the project; hooks written for all: /, 'the notes of the steps show up');
  assert.match(first.stdout, /ok {4}kit check/, 'setup runs the session-start check');
  assert.match(first.stdout, /ok {4}Impeccable hooks: off for this project/, 'an empty project has no UI files: no Impeccable download');
  for (const file of ['AGENTS.md', '.github/workflow-project.json', '.claude/settings.json', '.codex/hooks.json', '.agents/skills/ponytail/SKILL.md', '.claude/skills/find-skills/SKILL.md'])
    assert.ok(existsSync(join(project, file)), file);
  assert.ok(lstatSync(join(project, '.vendor/workflow-kit')).isSymbolicLink() || lstatSync(join(project, '.vendor/workflow-kit')).isDirectory());
  const before = [snapshot(project), snapshot(home)];
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual([snapshot(project), snapshot(home)], before);
});

test('kit setup does not write the profile through a link that leaves the project (#797)', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t), outside = temporary(t, 'kit setup outside ');
  writeFileSync(join(project, 'AGENTS.md'), 'own\n');
  symlinkSync(outside, join(project, '.github'), 'junction');
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL {2}profile/);
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the link');
});


test('a board with a differently named status is told which name is missing and how to map it', () => {
  const board = ['Backlog', 'Ready', 'In progress', 'Auto review', 'Human review', 'Done'];
  assert.equal(statusMismatch([...board.slice(0, 3), 'Automated review', ...board.slice(4)], {}), null);
  const message = statusMismatch(board, {});
  assert.match(message, /Missing on the board: "Automated review"/);
  assert.match(message, /Not expected: "Auto review"/);
  assert.match(message, /"statuses":\{"automatedReview":"Auto review"\}/);
  assert.equal(statusMismatch(board, { statuses: { automatedReview: 'Auto review' } }), null, 'the mapped name is accepted');
  assert.match(statusMismatch(['Ready', 'Backlog', 'In progress', 'Automated review', 'Human review', 'Done'], {}), /order differs/);
});
