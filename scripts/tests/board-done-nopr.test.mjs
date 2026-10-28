import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffFixture, issue, test } from './board-fixture.mjs';
import { delivery, showPr } from './board-done-fixture.mjs';

test('done closes a PR without a change, puts the result on the issue and moves it to Human review', t => {
  const { run, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('pr.json'), JSON.stringify({ ...json('pr.json'), changedFiles: 0 }));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^CLOSED PR #7 /m);
  assert.equal(json('pr.json').state, 'CLOSED');
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '', 'nothing to test');
});

for (const path of ['fix.txt', ' ']) test(`done refuses stale zero-file metadata when immutable Git contains a pushed change (${JSON.stringify(path)})`, t => {
  if (path === ' ' && process.platform === 'win32') return t.skip('Win32 Git rejects whitespace-only paths; Linux CI covers this Git-diff regression');
  const { run, file, text, json, git, restOverlays } = delivery(t, handoffFixture);
  writeFileSync(file(path), 'real fix');
  git('add', path);
  git('commit', '-q', '-m', 'fix');
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD'), changedFiles: 0 });
  restOverlays([{ changedFiles: 0 }, { changedFiles: 1 }]);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('stored'), 'In progress');
  assert.equal(text('affected-tests-calls'), '');
});

for (const [name, first, second] of [
  ['changed remote head', {}, { headRefOid: 'b'.repeat(40) }],
  ['changed remote base', {}, { baseRefOid: 'b'.repeat(40) }],
  ['contradictory counter', {}, { changedFiles: 1 }],
  ['unreadable base commit', { baseRefOid: 'b'.repeat(40) }, {}],
  ['head differs from checkout', { headRefOid: 'b'.repeat(40) }, {}],
]) test(`done leaves issue and PR untouched for no-change ${name}`, t => {
  const { run, file, text, json, restOverlays } = delivery(t, handoffFixture);
  restOverlays([{ changedFiles: 0, ...first }, second]);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('stored'), 'In progress');
});

for (const action of ['push', 'delete']) test(`done refuses a live remote ${action} hidden by stale empty PR metadata`, t => {
  const { run, file, text, json, git } = delivery(t, handoffFixture);
  git('checkout', '-q', '-b', 'other');
  writeFileSync(file('fix.txt'), 'remote fix');
  git('add', 'fix.txt');
  git('commit', '-q', '-m', 'remote fix');
  git('push', '-q', 'origin', 'other:work');
  if (action === 'delete') git('push', '-q', 'origin', '--delete', 'work');
  git('checkout', '-q', 'work');
  showPr(file, json, { changedFiles: 0 }); // stale local checkout and both PR reads still point at the empty head
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('stored'), 'In progress');
});

test('done refuses to push from a checkout on main or release/** and changes nothing (#646)', t => {
  const { run, git, text, file, checkout } = delivery(t, handoffFixture);
  git('switch', '-C', 'release/0.1.1');
  writeFileSync(join(checkout, '.git/hooks/pre-push'), `#!/bin/sh\necho push >> "${checkout.replaceAll('\\', '/')}/pushes"\n`, { mode: 0o755 });
  const result = run('done', '1', 'result.md');
  assert.equal(existsSync(join(checkout, 'pushes')), false, 'no push attempt');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED/m);
  assert.equal(text('stored'), 'In progress');
  assert.equal(existsSync(file('mutations')), false);
});

test('done without any PR puts the result on the issue, ticks the boxes and moves it to Human review only with --no-pr (#646)', t => {
  const { run, text, json } = delivery(t, fixture); // no PR closes the issue
  let result = run('done', '1');
  assert.equal(result.status === 0, false, 'no PR and no file');
  assert.equal(text('stored'), 'In progress');
  result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, 'a FILE alone does not set the status');
  assert.match(result.stdout, /no PR for #1, so the status stays/);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
  result = run('done', '1', 'result.md', '--no-pr');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^DONE #1 \(no PR\)/m);
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done');
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '', 'nothing to test');
});

test('done --no-pr run again after a later step failed writes the result comment only once (#993)', t => {
  const { run, text, file, json } = delivery(t, fixture);
  assert.equal(run('done', '1', 'result.md', '--no-pr').status, 0);
  writeFileSync(file('stored'), 'In progress'); // the status step did not land
  const again = run('done', '1', 'result.md', '--no-pr');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(json('issues-comments.json').length, 1, 'one result comment');
  assert.equal(text('stored'), 'Human review');
});

test('done without a PR refuses when the issue carries a claim but no commit yet, and changes nothing (#907)', t => {
  const { run, writeIssue, text, json } = delivery(t, fixture); // the branch has no commit of its own
  writeIssue({ ...issue('In progress'), assignees: { nodes: [{ login: 'worker' }] }, comments: { nodes: [{ body: 'Agent: claude, Session: S907\nBasis: release/0.1.1' }] } });
  const result = run('done', '1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
});

const mergedDelivery = { number: 7, state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) }, repository: { nameWithOwner: 'test/example' } };
const closedDelivery = () => ({ ...issue('Done'), state: 'CLOSED', stateReason: 'COMPLETED',
  closedByPullRequestsReferences: { totalCount: 1, nodes: [mergedDelivery] } });

test('done Prepare then external merge then FILE preserves Done, body and comments with readable merge evidence', t => {
  const { run, file, text, json, writeIssue } = delivery(t, handoffFixture);
  assert.equal(run('done', '1').status, 0, 'Prepare succeeds before the external merge');
  showPr(file, json, { state: 'MERGED', mergeCommit: mergedDelivery.mergeCommit });
  writeIssue(closedDelivery());
  writeFileSync(file('stored'), 'Done');
  const before = ['stored', 'backlink-1.json', 'issues-comments.json', 'mutations', 'affected-tests-calls'].map(text);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALREADY DONE #1: closed as completed; PR #7 merged \(f{40}\); no changes/);
  assert.deepEqual(['stored', 'backlink-1.json', 'issues-comments.json', 'mutations', 'affected-tests-calls'].map(text), before);
});

test('done re-reads external closure before the first No-PR mutation', t => {
  const { run, file, text, json } = delivery(t, fixture);
  writeFileSync(file('issue-next.json'), JSON.stringify(closedDelivery()));
  writeFileSync(file('stored'), 'Done');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALREADY DONE #1/);
  assert.equal(text('stored'), 'Done');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('mutations'), '');
  assert.equal(text('affected-tests-calls'), '');
  assert.ok(text('queries').split('\n').some(line => line.includes('includeClosedPrs:true')), 'closed PRs must be requested from GitHub');
});

for (const [name, changes] of [
  ['unreadable issue state', { state: null }],
  ['unreadable closure reason', { stateReason: null }],
  ['not-planned closure', { stateReason: 'NOT_PLANNED' }],
  ['incomplete PR list', { closedByPullRequestsReferences: { totalCount: 2, nodes: [mergedDelivery] } }],
  ['unreadable PR state', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, state: null }] } }],
  ['unreadable merge commit', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, mergeCommit: null }] } }],
  ['unmerged linked PR', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, state: 'CLOSED' }] } }],
  ['unrelated merged PR', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, repository: { nameWithOwner: 'other/repo' } }] } }],
  ['new open PR', { state: 'OPEN', closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, state: 'OPEN' }] } }],
]) test(`done refuses No-PR ${name} before any mutation`, t => {
  const { run, file, text, json } = delivery(t, fixture);
  writeFileSync(file('issue-next.json'), JSON.stringify({ ...closedDelivery(), ...changes }));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAILED\nblocker: cannot confirm issue closure for #1/);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('mutations'), '');
  assert.equal(text('affected-tests-calls'), '');
});

test('done delivers a human-reopened issue through the existing No-PR handoff', t => {
  const { run, text, json, writeIssue } = delivery(t, fixture);
  writeIssue({ ...closedDelivery(), state: 'OPEN', stateReason: 'REOPENED' });
  const result = run('done', '1', 'result.md', '--no-pr');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^DONE #1 \(no PR\)/m);
  assert.equal(text('stored'), 'Human review');
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.ok(json('backlink-1.json').body.startsWith('- [x] first'));
});

test('done leaves issue untouched when the API closure read fails', t => {
  const { run, file, text, json } = delivery(t, fixture);
  writeFileSync(file('fail'), '');
  const result = run('done', '1', 'result.md');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /test\/example#1/);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('mutations'), '');
});

test('done hands a partial PR off without a native link, status or ticked boxes, also when no other PR closes the issue', t => {
  const { run, writeIssue, text, json } = delivery(t, fixture);
  // No PR closes the issue: the PR only names it, and the issue is neither assigned nor in review.
  writeIssue(issue('In progress'));
  const result = run('done', '1', '7', 'result.md', '--refs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^HANDOFF #1 PR #7 /m);
  assert.equal(text('stored'), 'In progress', 'the issue status stays');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'the boxes of the issue stay open');
  assert.equal(json('pr.json').isDraft, false);
});

test('done keeps an empty --refs PR on the regular test and review path', t => {
  const { run, file, text, json } = delivery(t, handoffFixture);
  showPr(file, json, { changedFiles: 0 });
  const result = run('done', '1', '7', 'result.md', '--refs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.match(text('affected-tests-calls'), /--run/);
  assert.equal(text('stored'), 'In progress');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
});

test('done with a handoff file moves a head without handoff off Human review and leaves it there after a red wait (#947)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  writeFileSync(file('stored'), 'Human review');
  const pr = json('pr.json');
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), [], 'no handoff for a red head');
});

test('done ends a PR without any check as a blocker instead of waiting forever (#947)', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  const pr = json('pr.json');
  const commit = pr.commits.nodes[0].commit;
  commit.statusCheckRollup.contexts = { totalCount: 0, nodes: [] };
  commit.checkSuites = { totalCount: 0, nodes: [] };
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md', '--max-minutes', '0.01');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /no CI run on the head/);
});

test('done writes no handoff when another push changed the head during the wait (#947)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  // The REST reads before the wait show the pushed head; the next one shows a foreign push.
  const foreign = 'b'.repeat(40), commits = json('pr.json').commits;
  commits.nodes[0].commit.oid = foreign;
  writeFileSync(file('pr-rest-reads.json'), JSON.stringify([...Array(4).fill({}), { headRefOid: foreign, commits }]));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /head changed while waiting/);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
});

test('done reports a PR merged during the wait and changes nothing on the issue (#982)', t => {
  const { run, json, text, checkout } = delivery(t, handoffFixture);
  writeFileSync(join(checkout, 'pr-reads.json'), JSON.stringify([...Array(1).fill({}), { state: 'MERGED' }]));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ALREADY MERGED #1/m);
  assert.doesNotMatch(result.stdout + result.stderr, /TypeError/);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'no ticks');
});

test('done ticks and posts nothing while the wait ends on a blocker only (#982)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  const pr = json('pr.json');
  pr.latestOpinionatedReviews = { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] };
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker: changes requested by reviewer/m);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'no ticks');
});

