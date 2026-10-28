import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handoffFixture, test } from './board-fixture.mjs';
import { delivery, showPr, moveBase, baseMergePolicy } from './board-done-fixture.mjs';

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

test('done pushes the merged base to its own branch although the upstream is the base (#651)', t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head);
  git('branch', '--set-upstream-to=origin/release/0.1.1');
  showPr(file, json, { isDraft: false });
  assert.equal(run('done', '1', 'result.md').status, 1);
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, head);
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${merged}`), 'the merge is pushed to the branch');
  assert.equal(git('rev-parse', '--abbrev-ref', '@{u}'), 'origin/work');
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

test('done does not abort a merge the user resolved and has not committed yet', t => {
  const { run, git, checkout, text } = delivery(t, handoffFixture);
  moveBase(git, checkout, { 'a.txt': 'theirs' }, { 'a.txt': 'mine' });
  const own = git('rev-parse', 'HEAD');
  try { git('merge', '--no-commit', 'origin/release/0.1.1'); } catch { /* the conflict is resolved below */ }
  writeFileSync(join(checkout, 'a.txt'), 'resolved');
  git('add', 'a.txt');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /commit the resolved merge, then run done again/);
  assert.ok(existsSync(join(checkout, '.git', 'MERGE_HEAD')), 'the resolved merge is still in progress');
  assert.equal(git('rev-parse', 'HEAD'), own, 'no commit was made or aborted');
  assert.equal(git('diff', '--cached', '--name-only'), 'a.txt', 'the resolved file is still staged');
  assert.equal(text('affected-tests-calls'), '', 'the tests did not run');
});


test('done counts --max-minutes from its start, so slow tests leave less time to wait and the call ends before the shell limit', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  const pending = json('pr.json');
  pending.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null }];
  writeFileSync(file('pr.json'), JSON.stringify(pending));
  writeFileSync(file('affected-tests-seconds'), '2');
  const result = run('done', '1', 'result.md', '--max-minutes', '0.05'); // 3 s, of which the tests (2 s) use most
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /^still waiting: call done again$/m);
  // Only the wait itself is timed (its own line), not the whole process: start-up and teardown of the child grow under load (#967).
  // The wait gets at most the 1 s left of the 3 s; a full period of its own would take 3 s.
  const waited = Number(/^done: CI and reviews took ([\d.]+) s$/m.exec(result.stdout)?.[1]);
  assert.ok(waited < 2.5, `the wait did not start its own full period after the tests (took ${waited} s)`);
});

