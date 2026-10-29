import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffFixture, issue, test } from './board-fixture.mjs';
import { delivery, showPr, moveBase, baseMergePolicy } from './board-done-fixture.mjs';

test('done refuses a spec before acceptance comments or body changes', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Backlog'), labels: { nodes: [{ name: 'spec' }] } });
  writeFileSync(join(checkout, 'result.md'), 'Spec accepted\n\n### Retro\n\n- Keine Funde');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /done is refused/);
  for (const name of ['mutations', 'comment-writes', 'body-writes']) assert.equal(existsSync(join(checkout, name)), false, name);
});

test('done completes first setup on a proved unconfigured base with the normal gates (#1077)', t => {
  const { run, file, text } = delivery(t, handoffFixture);
  writeFileSync(file('base-missing'), '');
  writeFileSync(file('base-bootstrap.json'), '{}');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(text('affected-tests-calls'), /--run/, 'first setup still runs tests');
  assert.equal(text('stored'), 'Human review');
});

test('done first setup cannot ignore failed CI through the local profile (#1077)', t => {
  const { run, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-missing'), '');
  writeFileSync(file('base-bootstrap.json'), '{}');
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), ignoredChecks: ['CI'] }));
  const pr = json('pr.json');
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = 'FAILURE';
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /check CI.*FAILURE|CI.*failed/i);
  assert.notEqual(text('stored'), 'Human review');
  assert.equal(json('issues-comments.json').length, 0, 'no handoff');
});

test('done refuses a deleted or unreadable base profile before writes (#1077)', t => {
  for (const history of [[{ sha: 'a'.repeat(40) }], {}]) {
    const { run, file, text, json } = delivery(t, handoffFixture);
    writeFileSync(file('base-missing'), '');
    writeFileSync(file('base-bootstrap.json'), JSON.stringify({ history }));
    const result = run('done', '1', 'result.md');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /profile existed before or its history is unreadable/);
    assert.equal(text('stored'), 'In progress');
    assert.equal(json('pr.json').isDraft, true);
    for (const name of ['mutations', 'comment-writes', 'body-writes', 'affected-tests-calls']) assert.equal(text(name), '', name);
  }
});


test('done prepares and hands off the review status without rewriting the review option on resume (#593)', t => {
  for (const status of ['Automated review']) {
    const { run, file, text, json } = delivery(t, handoffFixture);
    writeFileSync(file('status-options.json'), JSON.stringify(['In progress', status, 'Human review']));
    let result = run('done', '1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^PREPARED #1 /m);
    assert.equal(text('stored'), status, 'Write the existing option');
    const mutations = text('mutations');
    result = run('done', '1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text('mutations'), mutations, 'Resume must recognize the alias already stored');
    result = run('done', '1', 'result.md');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text('stored'), 'Human review');
    assert.equal(json('issues-comments.json').length, 1, 'One handoff, with the existing gates');
  }
});

test('done refuses missing review options before merging, pushing or ready mutations (#593 delta)', t => {
  const { run, file, text, json, git, checkout } = delivery(t, handoffFixture);
  moveBase(git, checkout, { 'base.txt': 'moved base' }, { 'own.txt': 'own change' });
  git('push', '-q', 'origin', 'work');
  const head = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: head });
  writeFileSync(file('status-options.json'), JSON.stringify(['In progress', 'Human review']));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /Automated review.*is not an option/);
  assert.equal(git('rev-parse', 'HEAD'), head, 'No base merge');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0], head, 'No push');
  assert.equal(json('pr.json').isDraft, true, 'No ready mutation');
  for (const name of ['mutations', 'comment-writes', 'body-writes', 'affected-tests-calls']) assert.equal(text(name), '', name);
  assert.equal(text('stored'), 'In progress', 'No status mutation');
});


test('done overlap policy from the remote target base keeps unrelated moves off the pushed head', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'always' }));
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  git('push', '-q', 'origin', 'work');
  const own = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: own });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${own}`));
  assert.equal(readFileSync(join(checkout, '.git', 'board-done-tested'), 'utf8'), own);
  assert.match(text('affected-tests-calls'), /--run/);
  assert.equal(text('stored'), 'Human review');
});

test('done pushes a new local commit even when the overlap policy needs no base merge (#659)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md'); // the PR still shows the old head, so ready may refuse; the push must have happened first
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0], own, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), own, 'No base merge');
});

test('done pushes a local commit that already has a tested marker but is not on the PR (#656)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  const own = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, '.git', 'board-done-tested'), own);
  const result = run('done', '1', 'result.md');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0], own, result.stdout + result.stderr);
});

test('done overlap policy merges a shared file even when both edits can merge cleanly', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, { 'shared.txt': 'same' }, { 'shared.txt': 'same' });
  git('push', '-q', 'origin', 'work');
  const own = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: own, isDraft: false });
  assert.equal(run('done', '1', 'result.md').status, 1, 'the merged head must become visible on the PR before delivery');
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, own);
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', merged);
  assert.equal(readFileSync(join(checkout, '.git', 'board-done-tested'), 'utf8'), merged);
  showPr(file, json, { headRefOid: merged });
  assert.equal(run('done', '1', 'result.md').status, 0);
});

for (const [name, theirs, mine] of [
  ['shared-file conflict', { 'a.txt': 'theirs' }, { 'a.txt': 'mine' }],
  ['directory/file conflict with distinct changed paths', { 'path/file.txt': 'theirs' }, { path: 'mine' }],
]) test(`done overlap policy refuses ${name} before tests and status writes`, t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, theirs, mine);
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.ok(!existsSync(join(checkout, '.git', 'MERGE_HEAD')));
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
});

for (const policy of [null, 'never']) test(`done rejects malformed base merge policy ${policy} before writes`, t => {
  const { run, git, file, text, json, head } = delivery(t, handoffFixture);
  baseMergePolicy(file, json, policy);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
  assert.equal(json('pr.json').isDraft, true);
});

test('done overlap comparison fails closed when the fetched PR base does not exist', t => {
  const { run, git, file, text, json, head } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  showPr(file, json, { baseRefName: 'missing' });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
});

