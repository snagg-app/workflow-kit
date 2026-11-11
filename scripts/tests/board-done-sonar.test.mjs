import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { handoffFixture, test } from './board-fixture.mjs';
import { delivery, showPr, moveBase } from './board-done-fixture.mjs';

// #1098: a project with the Sonar app in awaitApps gets the local analysis before the push of `done`.
function sonarDelivery(t, local) {
  const d = delivery(t, handoffFixture);
  writeFileSync(d.file('base-project.json'), JSON.stringify({ ...d.json('.github/workflow-project.json'), awaitApps: ['sonarqubecloud'] }));
  if (local) writeFileSync(d.file('sonar-local.json'), JSON.stringify(local));
  moveBase(d.git, d.checkout); // the branch has an own commit to push
  showPr(d.file, d.json, { isDraft: false });
  return d;
}
const pushed = ({ git }) => git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0];

test('done stops before the push when the local Sonar analysis has findings', t => {
  const d = sonarDelivery(t, { status: 'findings', text: 'java:S1192 Foo.java:3' });
  const run = d.run('done', '1', 'result.md');
  assert.equal(run.status, 1);
  assert.match(run.stderr + run.stdout, /java:S1192 Foo\.java:3/);
  assert.equal(pushed(d), d.head, 'nothing is pushed');
});

test('done goes on when the local Sonar analysis is clean', t => {
  const d = sonarDelivery(t);
  d.run('done', '1', 'result.md');
  assert.equal(d.text('sonar-local-calls').trim(), d.git('merge-base', 'HEAD', 'origin/release/0.1.1'), 'the analysis runs against the merge-base');
  assert.equal(pushed(d), d.git('rev-parse', 'HEAD'), 'the head is pushed');
});

test('done only warns when the Sonar CLI is missing or not logged in', t => {
  const d = sonarDelivery(t, { status: 'unavailable', text: 'spawnSync sonar ENOENT' });
  const run = d.run('done', '1', 'result.md');
  assert.match(run.stdout + run.stderr, /WARNING: local Sonar analysis skipped \(spawnSync sonar ENOENT\)/);
  assert.equal(pushed(d), d.git('rev-parse', 'HEAD'), 'the head is pushed');
});
