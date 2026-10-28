import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderReadme } from '../board-readme.mjs';
import { handoffFixture, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';
import { delivery, showPr, moveBase, baseMergePolicy } from './board-done-fixture.mjs';

test('done refuses a migration change without a code-review of the head, and goes on once the review is recorded (#1036)', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, {}, { 'backend/db/migration/V1__ä.sql': 'select 1' });
  git('push', '-q', 'origin', 'work');
  const own = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: own });
  assert.equal(run('done', '1', 'result.md').status, 1);
  assert.equal(text('affected-tests-calls'), '', 'refused before the tests');

  execFileSync(process.execPath, [new URL('../review-marker.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { cwd: checkout, env: isolatedGit(dirname(checkout)) });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('stored'), 'Human review');
});

test('done asks for a code-review of the paths the project lists, and for no migration once the list leaves it out (#1042)', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap', reviewRequiredPaths: ['src/**/security/*.java'] }));
  moveBase(git, checkout, {}, { 'backend/db/migration/V1__a.sql': 'select 1', 'src/app/security/Guard.java': 'class Guard {}' });
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  const refused = run('done', '1', 'result.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /Guard\.java/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /V1__a/);

  execFileSync(process.execPath, [new URL('../review-marker.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { cwd: checkout, env: isolatedGit(dirname(checkout)) });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('stored'), 'Human review');
});

test('done asks for no code-review of a migration when the project lists no path (#1042)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap', reviewRequiredPaths: [] }));
  moveBase(git, checkout, {}, { 'backend/db/migration/V1__a.sql': 'select 1' });
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  assert.equal(run('done', '1', 'result.md').status, 0);
});

test('done asks for a code-review once the diff reaches 3 modules of reviewModuleRoots, and for none at 2 (#1055)', t => {
  for (const [files, refusedAt] of [[{ 'backend/domain/A.java': 'a', 'backend/api/B.java': 'b', 'backend/README.md': 'not in a module', 'docs/x.md': 'x' }, null],
    [{ 'backend/domain/A.java': 'a', 'backend/api/B.java': 'b', 'backend/importer/C.java': 'c' }, /C\.java/]]) {
    const { run, git, checkout, file, json } = delivery(t, handoffFixture);
    writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap', reviewRequiredPaths: [], reviewModuleRoots: ['backend'] }));
    moveBase(git, checkout, {}, files);
    git('push', '-q', 'origin', 'work');
    showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
    const result = run('done', '1', 'result.md');
    if (refusedAt) {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, refusedAt);
      assert.match(result.stdout + result.stderr, /"reviewModuleRoots"/);
    } else assert.equal(result.status, 0, 'two modules and files outside modules need no review: ' + result.stdout + result.stderr);
  }
});

test('done in the kit refuses a new script without an affected-tests row before the push (#1046)', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, {}, { 'scripts/board-readme.mjs': '', 'README.md': renderReadme('<!-- board-commands:start -->\n<!-- board-commands:end -->\n'), 'scripts/brand-new-tool.mjs': '' });
  const remote = git('ls-remote', 'origin', 'refs/heads/work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  const refused = run('done', '1', 'result.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /brand-new-tool\.mjs/);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work'), remote, 'nothing was pushed');
  assert.equal(text('affected-tests-calls'), '', 'refused before the tests');
});

test('done does not ask for a code-review when no migration changes', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, {}, { 'fix.txt': 'fix' });
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  assert.equal(run('done', '1', 'result.md').status, 0);
});
