import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewsFixture, test } from './board-fixture.mjs';

test('wait ends at once on merge conflicts of a non-draft PR and ignores every other merge state', t => {
  const { checkout, run, minutesAgo, check, suite, pr, look, reviews } = reviewsFixture(t);
  // Conflicts start no workflow: without any check, a non-draft PR would wait for "first CI check" forever.
  const noCi = mergeStateStatus => look({ ...pr({ contexts: [] }), isDraft: false, mergeStateStatus });
  const conflicted = noCi('DIRTY');
  assert.equal(conflicted.status, 1, 'Merge conflicts end the wait at once, however little CI there is');
  assert.match(conflicted.stdout, /^FAILED: merge conflicts$/m);
  assert.match(conflicted.stdout, /^blocker: merge conflicts$/m);
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(noCi('DIRTY').status, 1, 'A later read failure keeps the known conflict verdict');
  rmSync(join(checkout, 'fail-rest'));
  writeFileSync(join(checkout, 'activity.json'), JSON.stringify([{ after: 'abcdef1234', timestamp: minutesAgo(1) }]));
  for (const state of ['UNKNOWN', 'BEHIND']) assert.equal(noCi(state).status, 3, `${state} keeps waiting`);
  rmSync(join(checkout, 'activity.json'));
  // The incident: a Draft whose checks were all skipped read as done. `wait` itself must end FAILED.
  look({ ...pr({ contexts: [check('COMPLETED', 'SKIPPED')], suites: [suite('COMPLETED', 1, 5, 'SKIPPED')] }), isDraft: true });
  const draft = run('wait', '7', '--max-minutes', '0.1');
  assert.equal(draft.status, 1, 'A Draft with only skipped checks is never DONE');
  assert.match(draft.stdout, /^blocker: PR is still Draft; run board\.mjs done ISSUE$/m);
  const readied = { ...pr({ pushed: 5 }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(5) }] } };
  assert.equal(reviews({ ...readied, mergeStateStatus: 'BEHIND' }), 0, 'BEHIND is no conflict');
});

test('wait rejects current-head Sonar issues, accepts zero, and preserves pending and head guards (#598)', t => {
  const { checkout, run, pr, look } = reviewsFixture(t);
  const sonar = { __typename: 'CheckRun', name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS',
    summary: '[4 New issues]', detailsUrl: 'https://sonarcloud.io/dashboard?id=test_example&pullRequest=7',
    checkSuite: { app: { slug: 'sonarqubecloud' } } };
  // reviewsFixture inherits the environment; no token must trigger a real Sonar request.
  const token = process.env.SONAR_TOKEN;
  process.env.SONAR_TOKEN = '';
  t.after(() => { if (token === undefined) delete process.env.SONAR_TOKEN; else process.env.SONAR_TOKEN = token; });
  for (const [changes, expected] of [[{}, 1], [{ summary: '[0 New issues]' }, 0], [{ status: 'IN_PROGRESS', conclusion: null }, 4]]) {
    look(pr({ contexts: [{ ...sonar, ...changes }] }));
    const result = run('wait', '7', '--max-minutes', '0.01');
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected === 1) {
      assert.match(result.stdout, /^FAILED: 4 open Sonar issues$/m);
      assert.match(result.stdout, /^sonar: 4 open issues$/m);
      assert.match(result.stdout, /^blocker: 4 open Sonar issues on this head/m);
    } else if (expected === 4) {
      assert.match(result.stdout, /^waiting: check SonarCloud Code Analysis$/m);
      assert.doesNotMatch(result.stdout, /^FAILED|^DONE/m);
    }
  }
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr({ contexts: [sonar] })));
  const oldHead = run('wait', '7', '--head', 'b'.repeat(40), '--max-minutes', '0.01');
  assert.equal(oldHead.status, 4, oldHead.stdout + oldHead.stderr);
  assert.match(oldHead.stdout, /^waiting: PR still shows head abcdef1, expected bbbbbbb$/m);
  assert.doesNotMatch(oldHead.stdout, /^FAILED|^DONE/m);
});

test('wait --head keeps waiting while the PR still shows the previous head, and a closed PR ends it', t => {
  const { checkout, run, runBriefly, pr } = reviewsFixture(t);
  const [old, pushed] = ['a', 'b'].map(letter => letter.repeat(40));
  const show = (head, changes) => {
    const data = pr(); // CI is green, so only the head can keep this PR waiting
    data.headRefOid = data.commits.nodes[0].commit.oid = head;
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...data, ...changes }));
    for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments', 'comments-reactions', 'pulls-reviews']) writeFileSync(join(checkout, `${file}.json`), '[]');
  };
  show(old);
  assert.equal(run('wait', '7').status, 0, 'Precondition: without --head the old head is DONE');
  assert.match(runBriefly(3000, 'wait', '7', '--head', pushed), /^WAITING\nwaiting: PR still shows head aaaaaaa, expected bbbbbbb/, 'The old head keeps waiting');
  show(pushed);
  assert.equal(run('wait', '7', '--head', pushed).status, 0, 'The expected head is DONE');
  show(old, { state: 'CLOSED' });
  assert.equal(run('wait', '7', '--head', pushed).status, 1, 'A closed PR ends the wait whatever its head');
  show(pushed);
  assert.equal(run('wait', '7', '--head', 'bbbbbbb').status, 0, 'The 7-character id of the head is DONE');
  assert.match(runBriefly(3000, 'wait', '7', '--head', 'ccccccc'), /^WAITING\nwaiting: PR still shows head bbbbbbb, expected ccccccc/, 'a short id of another commit keeps waiting');
  const short = run('wait', '7', '--head', 'bbbbbb');
  assert.equal(short.status, 2, 'Fewer than 7 characters are refused');
  assert.match(short.stderr, /commit id of 7 to 40 characters/, 'and the reason is named, not just the usage line');
  assert.equal(run('reviews', '7', '--head', pushed).status, 2, '--head belongs to wait');
});

test('wait gives up before the tool limit with exit 4 and names the quota reset when a pause would outlast it', t => {
  const { checkout, run, check, pr, look } = reviewsFixture(t);
  assert.equal(look(pr({ contexts: [check('IN_PROGRESS')] })).status, 3, 'Precondition: CI never finishes');
  const unfinished = run('wait', '7', '--max-minutes', '0.01');
  assert.equal(unfinished.status, 4, 'An unfinished wait ends with its own exit code');
  assert.match(unfinished.stdout, /^still waiting: call wait again$/m);
  // The fake gh reports an empty quota that resets in 3 s: sleeping until then would pass the deadline.
  writeFileSync(join(checkout, 'quota-left'), '0');
  const paused = run('wait', '7', '--max-minutes', '0.01');
  assert.equal(paused.status, 4);
  assert.match(paused.stdout, /^still waiting: call wait again after \d{4}-\d\d-\d\dT[\d:.]+Z \(GitHub quota pause\)$/m);
  assert.equal(run('wait', '7', '--max-minutes', 'abc').status, 2, 'A bad limit is refused, not read as no limit');
  assert.equal(run('reviews', '7', '--max-minutes', '1').status, 2, '--max-minutes belongs to wait');
});

// `wait` asks REST whether anything changed and reads GraphQL (the PR, then its review threads) only when it did (#324).
// --interval 0 makes many rounds out of the short --max-minutes; the fake gh counts the REST reads of the PR in rest-reads.
function restFixture(t) {
  const fixture = reviewsFixture(t);
  const { checkout, queries } = fixture;
  return {
    ...fixture,
    show: data => {
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(data));
      for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments', 'comments-reactions', 'pulls-reviews']) writeFileSync(join(checkout, `${file}.json`), '[]');
    },
    restReads: () => readFileSync(join(checkout, 'rest-reads'), 'utf8').trim().split('\n').length,
    // One full GraphQL query carries both PR state and its first page of review threads.
    graphqlSent: () => {
      const sent = queries();
      return { pr: sent.filter(query => query.includes('readyEvents')).length,
        threads: sent.filter(query => query.includes('reviewThreads') && !query.includes('readyEvents')).length, all: sent.length };
    },
  };
}

test('wait reads PR and threads in one GraphQL query per change REST reports', t => {
  const { checkout, run, check, pr, show, restReads, graphqlSent, restOverlays } = restFixture(t);
  show(pr({ contexts: [check('IN_PROGRESS')] })); // CI never finishes
  assert.equal(run('wait', '7', '--interval', '0', '--max-minutes', '0.02').status, 4, 'Precondition: the wait is still waiting');
  assert.ok(restReads() >= 3, 'Precondition: several rounds ran');
  assert.deepEqual(graphqlSent(), { pr: 1, threads: 0, all: 1 }, 'Many rounds without a change: one query carries PR and threads');

  // The third look at REST shows a new update time, the later ones keep it.
  restOverlays([{}, {}, { updatedAt: 'later' }]);
  assert.equal(run('wait', '7', '--interval', '0', '--max-minutes', '0.02').status, 4);
  assert.deepEqual(graphqlSent(), { pr: 2, threads: 0, all: 2 }, 'The change costs exactly one more query');
});

test('wait retries a missing cache when GraphQL initially lags behind the REST head', t => {
  const { checkout, run, check, pr, show, restReads, graphqlSent, restOverlays, graphqlReads } = restFixture(t);
  const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
  for (const [reason, changes] of [
    ['CI', { contexts: [check('IN_PROGRESS')] }],
    ['requested review', { contexts: [check('COMPLETED')], requests: ['maintainer'], threadPages: [[false]] }],
  ]) {
    const data = pr(changes);
    data.headRefOid = data.commits.nodes[0].commit.oid = newHead;
    const outdated = structuredClone(data);
    outdated.headRefOid = outdated.commits.nodes[0].commit.oid = oldHead;
    show(data);
    writeFileSync(join(checkout, 'rest-reads'), '');
    restOverlays([{ headRefOid: newHead }]);
    graphqlReads([outdated, data]);
    const result = run('wait', '7', '--interval', '0', '--max-minutes', '0.02');
    assert.equal(result.status, 4, `${reason} must keep waiting after the first uncached round: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^WAITING$/m);
    assert.doesNotMatch(result.stdout, /^DONE$/m, `${reason} is still a blocker`);
    assert.ok(restReads() >= 3, 'Precondition: at least two rounds followed the mismatched head');
    assert.deepEqual(graphqlSent(), { pr: 2, threads: 0, all: 2 }, 'The missing cache is read again, then the matching head can be cached');
    assert.equal(readFileSync(join(checkout, 'pr.json'), 'utf8').includes(newHead), true, 'GraphQL caught up to the REST head');
  }
});

test('wait confirms every end with a full read', t => {
  const { run, check, readyHead, show, graphqlSent } = restFixture(t);
  // Ready since 5 minutes with a 5 minute and 2 second grace: the cached look says "waiting" first, then "done" once the clock passed the grace.
  show(readyHead([check('COMPLETED')]));
  const result = run('wait', '7', '--interval', '0', '--max-minutes', '0.2', '--grace', String(5 + 2 / 60));
  assert.equal(result.status, 0, 'The grace ends the wait');
  assert.deepEqual(graphqlSent(), { pr: 2, threads: 0, all: 2 }, 'The first read, and the full read that confirms the end');
});

test('wait keeps reading REST while the GraphQL quota is used up, and finishes after the reset', t => {
  const { checkout, run, check, pr, show, restReads, graphqlSent } = restFixture(t);
  show(pr({ contexts: [check('COMPLETED')] }));
  // GitHub refuses the first query and names a reset within a second: wait does not sleep through it or give up, it looks over REST meanwhile.
  writeFileSync(join(checkout, 'limited'), '');
  const result = run('wait', '7', '--interval', '0.2', '--max-minutes', '0.2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(restReads() >= 2, 'REST was read in the round of the pause');
  assert.ok(graphqlSent().pr >= 1, 'and the full read followed');

  // A GraphQL quota refusal with a reset beyond --max-minutes still reads REST until its deadline.
  writeFileSync(join(checkout, 'limited'), '');
  writeFileSync(join(checkout, 'rest-reads'), '');
  const outlasted = run('wait', '7', '--interval', '0.1', '--max-minutes', '0.01');
  assert.equal(outlasted.status, 4, outlasted.stdout + outlasted.stderr);
  assert.ok(restReads() >= 3, 'wait kept looking until its own limit');
  assert.match(outlasted.stdout, /\(GitHub quota pause\)$/m, 'and names the reset');
});

test('wait treats HTTP 200 GraphQL quota errors as a pause and keeps reading REST', t => {
  const { checkout, run, check, pr, show, restReads } = restFixture(t);
  show(pr({ contexts: [check('COMPLETED')] }));
  writeFileSync(join(checkout, 'limited-200'), '');
  const result = run('wait', '7', '--interval', '0.2', '--max-minutes', '0.2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(restReads() >= 2, 'REST was read during the quota pause');
});

test('wait --interval 0 still pauses 10 seconds between looks, so it cannot burn the shared quota', t => {
  const { env, run, pr, show, restReads } = restFixture(t);
  show(pr());
  env.BOARD_MIN_INTERVAL = undefined;
  assert.equal(run('wait', '7', '--merged', '--interval', '0', '--max-minutes', '0.05').status, 4);
  assert.ok(restReads() <= 2, 'A pause of 0 would read dozens of times in 3 s: ' + restReads());
});

test('wait --merged reads REST only, and --interval is bounded', t => {
  const { run, pr, show, graphqlSent } = restFixture(t);
  show(pr());
  assert.equal(run('wait', '7', '--merged', '--interval', '0', '--max-minutes', '0.02').status, 4, 'An open PR keeps waiting');
  show({ ...pr(), state: 'MERGED' });
  assert.equal(run('wait', '7', '--merged').status, 0);
  assert.equal(graphqlSent().all, 0, 'No GraphQL point is spent while waiting for the merge');
  assert.equal(run('wait', '7', '--interval', '301').status, 2, 'A pause above 5 minutes is refused');
  assert.equal(run('wait', '7', '--interval', 'x').status, 2, 'and so is a bad one');
});
