import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { initProject } from '../init-project.mjs';
import { keepCommitted } from '../keep-committed.mjs';
import { readProfile } from '../project-profile.mjs';
import { temporary } from './fixtures.mjs';

const bom = '﻿';

test('an aborted first run is completed by the next run (#959)', t => {
  const project = temporary(t, 'setup robustness project ');
  // A file where the issue-template folder belongs: the run fails after the first templates.
  mkdirSync(join(project, '.github'));
  writeFileSync(join(project, '.github/ISSUE_TEMPLATE'), 'in the way');
  assert.throws(() => initProject({ root: project, log: () => {} }));
  assert.ok(!existsSync(join(project, 'AGENTS.md')), 'AGENTS.md is written last: an aborted run still counts as new');
});

test('keepCommitted stops on a Git error other than "not a repository" (#959)', async t => {
  const project = temporary(t, 'setup robustness git ');
  writeFileSync(join(project, '.git'), 'not a gitfile');
  await assert.rejects(keepCommitted(project, () => 'ran', { log: () => {} }), /git/i);
});

test('keepCommitted runs the work outside a Git repository (#959)', async t => {
  const project = temporary(t, 'setup robustness plain ');
  assert.equal(await keepCommitted(project, () => 'ran', { log: () => {} }), 'ran');
});

test('JSON files and the profile of a project may start with a BOM (#959)', t => {
  const project = temporary(t, 'setup robustness bom ');
  execFileSync('git', ['init', '--quiet', project]);
  mkdirSync(join(project, '.claude'));
  mkdirSync(join(project, '.github'));
  writeFileSync(join(project, '.claude/settings.json'), bom + '{"permissions":{"allow":["x"]}}');
  writeFileSync(join(project, '.github/workflow-project.json'), bom + '{"language":"de"}');
  assert.equal(readProfile(project).language, 'de');
  initProject({ root: project, existing: true, log: () => {} });
});
