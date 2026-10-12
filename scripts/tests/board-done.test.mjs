import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, handoffFixture, handoffPr, issue, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

test('done refuses a spec before acceptance comments or body changes', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Backlog'), labels: { nodes: [{ name: 'spec' }] } });
  writeFileSync(join(checkout, 'result.md'), 'Spec accepted\n\n### Retro\n\n- Keine Funde');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /done is refused/);
  for (const name of ['mutations', 'comment-writes', 'body-writes']) assert.equal(existsSync(join(checkout, name)), false, name);
});

// A checkout with one commit, which the Draft PR 7 shows as its head, and the files the fake gh answers from.
function delivery(t, fixtureOf) {
  const { checkout, run, writeIssue } = fixtureOf(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  git('init', '-q', '-b', 'work');
  git('config', 'user.name', 't'); // board.mjs commits its merge with the checkout's own identity
  git('config', 'user.email', 't@t');
  git('commit', '--allow-empty', '-q', '-m', 'pushed');
  git('init', '-q', '--bare', join(dirname(checkout), 'origin.git'));
  git('remote', 'add', 'origin', join(dirname(checkout), 'origin.git'));
  git('push', '-q', 'origin', 'work', 'work:release/0.1.1'); // the base of PR 7 is at the head: nothing to merge
  const head = git('rev-parse', 'HEAD');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  const json = name => JSON.parse(text(name));
  const pr = handoffPr({ id: 'PR7', isDraft: true, headRefName: 'work', headRefOid: head, baseRefOid: head, isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' }, url: 'https://github.com/test/example/pull/7', body: 'Closes #1' });
  pr.commits.nodes[0].commit.oid = head;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('stored'), 'In progress');
  writeFileSync(file('issues-comments.json'), '[]');
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 1, body: '- [ ] first\n- [ ] moved on, see #12\n- [x] done' }));
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, body: 'https://github.com/test/example/pull/7', html_url: 'u' }]));
  writeFileSync(file('result.md'), 'Alles geliefert.\n\n### Retro\n\n- Keine Funde\n');
  writeIssue({ ...issue('In progress'), assignees: { nodes: [{ login: 'worker' }] } });
  return { run, writeIssue, head, file, text, json, git, checkout };
}

test('done prepares and hands off both review status schemas without rewriting the review option on resume (#593)', t => {
  for (const status of ['Auto review', 'Automated review']) {
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

// What GitHub shows of PR 7: the changes, and a head (also the one of its last commit).
function showPr(file, json, { headRefOid, ...changes }) {
  const pr = { ...json('pr.json'), ...changes };
  if (headRefOid) pr.headRefOid = pr.commits.nodes[0].commit.oid = headRefOid;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
}

// The base gets a commit that the branch lacks (files: written in it) and the branch an own commit (files: written in it).
function moveBase(git, checkout, theirs = {}, mine = {}) {
  const commit = (files, message) => {
    for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(checkout, name)), { recursive: true }); writeFileSync(join(checkout, name), content); git('add', name); }
    git('commit', '--allow-empty', '-q', '-m', message);
  };
  git('checkout', '-q', '-b', 'side');
  commit(theirs, 'base moved');
  git('push', '-q', 'origin', 'side:release/0.1.1');
  git('checkout', '-q', 'work');
  git('branch', '-q', '-D', 'side');
  commit(mine, 'own work');
}

function baseMergePolicy(file, json, doneBaseMerge = 'overlap') {
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge }));
}

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

test('done takes the pushed work to Human review: tests, ready, ticked boxes, Automated review, wait, handoff comment', t => {
  const { run, head, text, json, git } = delivery(t, handoffFixture);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), head, 'a branch with its base gets no merge commit');
  assert.match(result.stdout, /HANDOFF #1/);
  assert.match(text('affected-tests-calls'), /--run/, 'the targeted tests ran');
  assert.equal(json('pr.json').isDraft, false, 'the PR is ready');
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done', 'the box without a follow-up is ticked');
  assert.equal(text('stored'), 'Human review');
  const posted = json('issues-comments.json').at(-1).body;
  assert.match(posted, new RegExp(`^## Übergabe\\n\\nHead: ${head.slice(0, 7)}\\n\\nAlles geliefert\\.\\n\\n### Retro`));

  // The same call again: the comment for this head exists, so there is no second one.
  const comments = json('issues-comments.json').length;
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(json('issues-comments.json').length, comments);
  // ... and without the file, as after exit 4, the call still passes.
  assert.equal(run('done', '1').status, 0);
});

test('done without a handoff file prepares: tests, ready, Automated review, then PREPARED without comment, ticking or Human review; the final done takes the same head', t => {
  const { run, head, text, json, git, file } = delivery(t, handoffFixture);
  const result = run('done', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^PREPARED #1 head ${head.slice(0, 7)}`, 'm'));
  assert.match(text('affected-tests-calls'), /--run/, 'the targeted tests ran');
  assert.equal(json('pr.json').isDraft, false, 'the PR is ready');
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), [], 'no handoff comment');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'the boxes stay open');

  // The final call hands off the same head without repeating the tests.
  const tests = text('affected-tests-calls');
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(text('affected-tests-calls'), tests);
  assert.equal(text('stored'), 'Human review');
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done');
  assert.match(json('issues-comments.json').at(-1).body, new RegExp(`^## Übergabe\\n\\nHead: ${head.slice(0, 7)}`));

  // A head pushed after the preparation is tested again.
  git('commit', '--allow-empty', '-q', '-m', 'later');
  git('push', '-q', 'origin', 'work');
  const later = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: later });
  assert.match(run('done', '1').stdout, new RegExp(`^PREPARED #1 head ${later.slice(0, 7)}`, 'm'));
  assert.notEqual(text('affected-tests-calls'), tests, 'the new head was tested');
  assert.equal(text('stored'), 'Automated review', 'the new head leaves Human review');
});

test('done can explicitly skip local tests through preparation and handoff without a tested marker', t => {
  const { run, head, text, json, file } = delivery(t, handoffFixture);
  const reason = 'Historical proof unchanged after base merge';
  const prepared = run('done', '1', '--skip-local-tests', reason);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  assert.match(prepared.stdout, new RegExp(`LOCAL TESTS SKIPPED ${head}: ${reason}`));
  assert.match(prepared.stdout, /PREPARED.*local tests skipped/);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(existsSync(file('.git/board-done-tested')), false);
  assert.equal(json('pr.json').isDraft, false);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  const delivered = run('done', '1', 'result.md', '--skip-local-tests', reason);
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(existsSync(file('.git/board-done-tested')), false);
  assert.match(json('issues-comments.json').at(-1).body, new RegExp(`Head: ${head.slice(0, 7)}`));
});

test('done skip preserves an old tested SHA and still refuses failed CI on the new head', t => {
  const { run, head, text, json, file, git } = delivery(t, handoffFixture);
  writeFileSync(file('.git/board-done-tested'), head);
  git('commit', '--allow-empty', '-q', '-m', 'new head');
  git('push', '-q', 'origin', 'work');
  const later = git('rev-parse', 'HEAD');
  assert.notEqual(later, head);
  showPr(file, json, { headRefOid: later });
  const pr = json('pr.json');
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md', '--skip-local-tests', 'No local repeat');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('.git/board-done-tested'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
});

for (const reason of [[], [''], ['  '], ['--refs']]) test(`done refuses invalid skip reason ${JSON.stringify(reason)} before mutations`, t => {
  const { run, head, text, json, file, git } = delivery(t, handoffFixture);
  const result = run('done', '1', 'result.md', '--skip-local-tests', ...reason);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /--skip-local-tests needs a non-empty reason/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
  assert.equal(json('pr.json').isDraft, true);
  for (const name of ['mutations', 'comment-writes', 'body-writes', '.git/board-done-tested']) assert.equal(existsSync(file(name)), false, name);
});

test('done without a handoff file keeps the waiting and failure codes of the review', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  const pr = json('pr.json'), checks = conclusion => { pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion }]; writeFileSync(file('pr.json'), JSON.stringify(pr)); };
  checks(null);
  let result = run('done', '1', '--max-minutes', '0.01');
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /PREPARED/);
  checks('FAILURE');
  result = run('done', '1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /PREPARED/);
  assert.equal(text('stored'), 'Automated review');
});

test('done merges a base the branch is behind, pushes it and tests the merged head; a second call adds no merge commit', t => {
  const { run, head, git, checkout, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-project.json'), text('.github/workflow-project.json')); // target base omits the setting: always wins over a local overlap override
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap' }));
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head); // the last fetch is older than the base: done fetches it itself
  showPr(file, json, { isDraft: false }); // ready() refuses at once: the PR still shows the old head
  assert.equal(run('done', '1', 'result.md').status, 1);
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, head);
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', merged);
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${merged}`), 'the merge is pushed');
  assert.equal(readFileSync(join(checkout, '.git', 'board-done-tested'), 'utf8'), merged, 'the merged head was tested');

  showPr(file, json, { headRefOid: merged });
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(git('rev-parse', 'HEAD'), merged, 'a branch that has the base gets no merge commit');
  assert.match(text('affected-tests-calls'), /--run/);
});

// The origin answers the fetch of `done` by a script that fails `message` the first `fails` times (stderr like git's), then serves the real upload-pack; it counts its calls.
function flakyFetch(git, checkout, fails, message) {
  writeFileSync(join(checkout, 'upload-pack.sh'), `echo x >> attempts\n[ "$(wc -l < attempts)" -le ${fails} ] && { echo "${message}" >&2; exit 1; }\nexec git upload-pack "$1"\n`);
  git('config', 'remote.origin.uploadpack', 'sh upload-pack.sh');
  return () => readFileSync(join(checkout, 'attempts'), 'utf8').trim().split('\n').length;
}

test('done repeats the fetch of the base when a ref is locked by a parallel fetch, and goes on', t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head);
  showPr(file, json, { isDraft: false });
  const attempts = flakyFetch(git, checkout, 2, "error: cannot lock ref 'refs/remotes/origin/release/0.1.1': is at x but expected y");
  run('done', '1', 'result.md');
  assert.equal(attempts(), 3, 'two refusals, then the third try fetched');
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', 'HEAD');
});

test('done does not repeat a fetch that fails for another reason', t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head);
  showPr(file, json, { isDraft: false });
  const attempts = flakyFetch(git, checkout, 9, 'fatal: Could not read from remote repository.');
  const result = run('done', '1', 'result.md');
  assert.equal(attempts(), 1);
  assert.match(result.stdout, /cannot fetch the base origin\/release\/0\.1\.1/);
});

for (const policy of ['always', 'overlap']) test(`done ${policy} does not merge a base that moved after the tests of this head: repeated calls only wait`, t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json, policy);
  moveBase(git, checkout);
  const own = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, '.git', 'board-done-tested'), own);
  showPr(file, json, { isDraft: false, headRefOid: own });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), own, 'no merge');
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${head}`), 'no push');
});

test('done neither merges nor pushes a checkout that is not on the PR branch', t => {
  const { run, git, checkout, text } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('checkout', '-q', '-b', 'other');
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not on the branch work/);
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/other'), '');
  assert.equal(text('affected-tests-calls'), '');
});

test('done fails on a conflict with the base, names the files and leaves no merge behind', t => {
  const { run, git, checkout, text } = delivery(t, handoffFixture);
  moveBase(git, checkout, { 'a.txt': 'theirs' }, { 'a.txt': 'mine' });
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker: .*a\.txt/);
  assert.ok(!existsSync(join(checkout, '.git', 'MERGE_HEAD')), 'the merge was aborted');
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(text('affected-tests-calls'), '', 'the tests did not run');
});


test('done counts --max-minutes from its start, so slow tests leave less time to wait and the call ends before the shell limit', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  const pending = json('pr.json');
  pending.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null }];
  writeFileSync(file('pr.json'), JSON.stringify(pending));
  writeFileSync(file('affected-tests-seconds'), '2');
  const started = Date.now(), result = run('done', '1', 'result.md', '--max-minutes', '0.05'); // 3 s, of which the tests (2 s) use most
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /^still waiting: call done again$/m);
  assert.ok(Date.now() - started < 4200, 'the wait did not start its own full period after the tests');
});

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
  const { run, file, text, json, git } = delivery(t, handoffFixture);
  writeFileSync(file(path), 'real fix');
  git('add', path);
  git('commit', '-q', '-m', 'fix');
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD'), changedFiles: 0 });
  writeFileSync(file('pr-rest-reads.json'), JSON.stringify([{ changedFiles: 0 }, { changedFiles: 1 }]));
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
  const { run, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('pr-rest-reads.json'), JSON.stringify([{ changedFiles: 0, ...first }, second]));
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

test('done without any PR puts the result on the issue, ticks the boxes and moves it to Human review; without a file it stops', t => {
  const { run, text, json } = delivery(t, fixture); // no PR closes the issue
  let result = run('done', '1');
  assert.equal(result.status === 0, false, 'no PR and no file');
  assert.match(result.stdout + result.stderr, /no open PR closes #1/);
  assert.equal(text('stored'), 'In progress');
  result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^DONE #1 \(no PR\)/m);
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done');
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '', 'nothing to test');
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
