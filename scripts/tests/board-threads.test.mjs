import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, test } from './board-fixture.mjs';

const thread = (databaseId, extra = {}) => ({ pr: 7, id: `T${databaseId}`, isResolved: false, isOutdated: false, path: 'scripts/a.mjs', line: 12, databaseId,
  url: `https://github.com/test/example/pull/7#discussion_r${databaseId}`, body: 'Fix this\nlonger text', author: 'coderabbitai', ...extra });

function setup(t, threads) {
  const board = fixture(t);
  writeFileSync(join(board.checkout, 'threads.json'), JSON.stringify(threads));
  const stored = () => JSON.parse(readFileSync(join(board.checkout, 'threads.json'), 'utf8'));
  return { ...board, stored };
}

test('threads lists the open threads of the PR with number, author, place, outdated and link, and writes nothing', t => {
  const { run, queries, checkout } = setup(t, [thread(101), thread(102, { isOutdated: true, line: null }), thread(103, { isResolved: true }), thread(201, { pr: 8 })]);
  const result = run('threads', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^open threads: 2$/m);
  assert.match(result.stdout, /^thread 101 @coderabbitai scripts\/a\.mjs:12 outdated: no - Fix this - https:\/\/github\.com\/test\/example\/pull\/7#discussion_r101$/m);
  assert.match(result.stdout, /^thread 102 .* scripts\/a\.mjs outdated: yes /m);
  assert.doesNotMatch(result.stdout, /thread 103|thread 201/, 'A resolved thread and a thread of another PR are not listed');
  assert.equal(queries().length, 1, 'One query lists the threads');
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'Listing never writes');
});

test('threads --resolve closes exactly the named threads, with an optional reply first, and reads the state back', t => {
  const { run, stored, checkout } = setup(t, [thread(101), thread(102)]);
  const result = run('threads', '7', '--resolve', '101', '--reply', 'Fixed in the next commit');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^resolved threads: 1, open threads: 1$/m);
  assert.match(result.stdout, /^thread 102 /m, 'The thread nobody named stays listed');
  assert.deepEqual(stored().map(entry => [entry.databaseId, entry.isResolved]), [[101, true], [102, false]], 'Nothing but the named thread is closed');
  assert.deepEqual(stored()[0].replies, ['Fixed in the next commit']);
  const mutations = readFileSync(join(checkout, 'mutations'), 'utf8');
  assert.ok(mutations.indexOf('addPullRequestReviewThreadReply') < mutations.indexOf('resolveReviewThread'), 'The reply comes before the closing');
});

test('threads --resolve refuses an unknown number and a thread of another PR before writing anything', t => {
  const { run, stored, checkout } = setup(t, [thread(101), thread(201, { pr: 8 })]);
  for (const wrong of ['999', '201']) {
    const result = run('threads', '7', '--resolve', '101', '--resolve', wrong);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`no review thread ${wrong} on PR #7; nothing was changed`));
  }
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  assert.equal(stored().some(entry => entry.isResolved), false);
});

test('threads fails when GitHub does not show the thread as resolved afterwards', t => {
  const { run, checkout } = setup(t, [thread(101)]);
  writeFileSync(join(checkout, 'resolve-noop'), '');
  const result = run('threads', '7', '--resolve', '101');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /not resolved after the write/);
});

test('threads names an already resolved thread without writing, and refuses --reply without --resolve', t => {
  const { run, checkout } = setup(t, [thread(101, { isResolved: true })]);
  const done = run('threads', '7', '--resolve', '101');
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /^thread 101 was already resolved$/m);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  assert.equal(run('threads', '7', '--reply', 'x').status, 2, '--reply alone is refused');
});
