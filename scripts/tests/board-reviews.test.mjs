import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffPr, reviewsFixture, test } from './board-fixture.mjs';



test('reviews waits only for traces on the current head and never reads failures as done', t => {
  const { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);

  assert.equal(reviews(pr()), 0, 'Green CI without other traces is done');
  // Codex starts on "ready for review" and shows its first trace a minute or two later, often after CI is green.
  const readied = (minutes, changes, pushed = 1) => ({ ...pr({ pushed }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(minutes) }] }, ...changes });
  assert.equal(reviews(readied(0.5)), 3, 'Green CI right after Ready still waits for reviewers to start');
  assert.equal(reviews(readied(5, {}, 5)), 0, 'After the grace a missing trace means no reviewer is coming');
  // Codex also reviews new commits: a push to a long-ready PR starts the grace again.
  assert.equal(reviews(readied(30, {}, 1)), 3, 'Green CI right after a push to a ready PR still waits for reviewers');
  assert.equal(reviews(readied(30, {}, 5)), 0, 'After the grace since the push a missing trace means no reviewer is coming');
  // A head set to an older commit keeps its old suites and commit date; only the branch's push log dates the new push.
  const pushedToBranch = minutes => writeFileSync(join(checkout, 'activity.json'), JSON.stringify([{ after: 'abcdef1234', timestamp: minutesAgo(minutes) }]));
  pushedToBranch(0.5);
  assert.equal(reviews(readied(30, {}, 5)), 3, 'Green CI on a reused commit just pushed to a ready PR still waits for reviewers');
  pushedToBranch(5);
  assert.equal(reviews(readied(30, {}, 5)), 0, 'Precondition: a reused commit pushed before the grace is done');
  // The same commit pushed twice: the latest push counts, in either order.
  const older = { after: 'abcdef1234', timestamp: minutesAgo(10) }, newer = { after: 'abcdef1234', timestamp: minutesAgo(0.5) };
  for (const log of [[older, newer], [newer, older]]) {
    writeFileSync(join(checkout, 'activity.json'), JSON.stringify(log));
    assert.equal(reviews(readied(30, {}, 5)), 3, 'The latest push of a repeated commit starts the grace');
  }
  writeFileSync(join(checkout, 'activity.json'), '[]');
  assert.equal(reviews(readied(30, {}, 5)), 2, 'An unreadable push time never reads as done');
  rmSync(join(checkout, 'activity.json'));
  assert.equal(reviews(readied(0.5), {}, '--grace', '0'), 0, 'The grace can be turned off');
  assert.equal(reviews(readied(-0.5)), 3, 'Precondition: a Ready after now still waits with the default grace');
  assert.equal(reviews(readied(-0.5), {}, '--grace', '0'), 0, 'Ready during the query (after now) does not revive a disabled grace');
  // Commit dates come from client clocks: one ahead of GitHub must not cut the grace short.
  const committed = minutes => ({ commits: { nodes: [{ commit: { ...pr().commits.nodes[0].commit, committedDate: minutesAgo(minutes) } }] } });
  assert.equal(reviews(readied(0.5, committed(-10))), 3, 'A commit date in the future does not cut the grace short');
  // A PR opened ready gets its first CI suite from the "opened" event, after its creation.
  assert.equal(reviews({ ...pr({ pushed: 0.2 }), isDraft: false, createdAt: minutesAgo(0.5) }), 3, 'A PR opened ready counts from its creation');
  // Correction pushes: heads pushed after the first Ready; the head that set Ready does not count, a repeated head counts once.
  const corrections = (pushes, changes) => {
    writeFileSync(join(checkout, 'activity.json'), JSON.stringify(pushes.map(([after, minutes]) => ({ after, timestamp: minutesAgo(minutes) }))));
    return look({ ...readied(30, {}, 5), firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] }, ...changes }).stdout;
  };
  // Only the number and the presence of the cap notice are checked, not the wording around them.
  const count = output => output.match(/correction pushes after ready: (\d+)/)?.[1];
  const cap = /cap reached/;
  const twoPushes = corrections([['abcdef1234', 5], ['bbbbbbb', 15], ['aaaaaaa', 25]]);
  assert.equal(count(twoPushes), '2');
  assert.match(twoPushes, cap);
  const onePush = corrections([['abcdef1234', 15], ['aaaaaaa', 25]]);
  assert.equal(count(onePush), '1');
  assert.doesNotMatch(onePush, cap);
  assert.doesNotMatch(corrections([['abcdef1234', 5], ['abcdef1234', 10], ['aaaaaaa', 25]]), cap, 'A repeated head is one push');
  assert.equal(count(corrections([['abcdef1234', 25]])), '0');
  assert.equal(count(corrections([['abcdef1234', 5], ['bbbbbbb', 15], ['abcdef1234', 25]])), '1', 'Pushing back to the head that set Ready is no new head');
  assert.equal(count(look({ ...pr(), firstReadyEvents: { nodes: [] } }).stdout), undefined, 'A PR that never was ready has no count');
  // A red head still reports the count, and an unreadable push log never turns the red verdict into ERROR.
  const red = { commits: pr({ pushed: 5, contexts: [check('COMPLETED', 'FAILURE')] }).commits };
  const redPushes = [['abcdef1234', 5], ['bbbbbbb', 15], ['aaaaaaa', 25]];
  assert.equal(count(corrections(redPushes, red)), '2', 'A red head reports the count too');
  assert.equal(look({ ...readied(30, {}, 5), ...red, firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] } }).status, 1);
  writeFileSync(join(checkout, 'activity.json'), 'unreadable');
  assert.equal(look({ ...readied(30, {}, 5), ...red, firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] } }).status, 1, 'An unreadable push log keeps the red verdict');
  // Without the grace nothing else reads the log, so an unreadable one must not turn green into ERROR either.
  assert.equal(look({ ...readied(30, {}, 5), firstReadyEvents: { nodes: [{ createdAt: minutesAgo(20) }] } }, undefined, '--grace', '0').status, 0, 'An unreadable push log keeps the green verdict');
  rmSync(join(checkout, 'activity.json'));
});


test('the reviewer grace ends when a required bot has answered and follows reviewerGraceMinutes', t => {
  const { checkout, minutesAgo, codexUser, check, pr, codex, reaction, reviews } = reviewsFixture(t);
  const config = join(checkout, '.github/workflow-project.json'), plain = readFileSync(config, 'utf8');
  const readied = { ...pr({ pushed: 1 }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(0.5) }] } };
  const say = (body, user = codexUser) => ({ id: 77, user, html_url: 'u', created_at: minutesAgo(0.2), updated_at: minutesAgo(0.2), body });
  assert.equal(reviews(readied), 3, 'Precondition: the grace is still running');
  assert.equal(reviews(readied, { comments: [say('You have reached your usage limits.')] }), 0, 'A limit notice ends the grace');
  assert.equal(reviews(readied, { reactions: [reaction('+1', 0.2)] }), 0, 'A final reaction ends the grace');
  assert.equal(reviews(readied, { comments: [codex('Running', 0.2)] }), 3, 'An unfinished Running summary does not end the grace');
  assert.equal(reviews(readied, { comments: [say('looks fine', { login: 'maintainer', type: 'User' })] }), 3, 'A human comment does not end the grace');
  assert.equal(reviews(readied, { comments: [say('coverage', { login: 'github-actions[bot]', type: 'Bot' })] }), 3, 'A CI comment does not end the grace');
  const limited = { ...check('COMPLETED'), name: 'CodeRabbit', description: 'Review rate limited', checkSuite: { app: { slug: 'coderabbitai' } } };
  assert.equal(reviews({ ...readied, ...pr({ contexts: [check('COMPLETED'), limited] }), isDraft: false, createdAt: readied.createdAt, readyEvents: readied.readyEvents }), 0, 'A limit notice on a check ends the grace');
  const ciLimited = { ...limited, name: 'CI', checkSuite: { app: { slug: 'github-actions' } } };
  assert.equal(reviews({ ...readied, ...pr({ contexts: [ciLimited] }), isDraft: false, createdAt: readied.createdAt, readyEvents: readied.readyEvents }), 3, 'A limit text in a CI check does not end the grace');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: ['chatgpt-codex-connector'] }));
  assert.equal(reviews(readied, { comments: [say('usage limits')] }), 3, 'An optional reviewer never ends the grace');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), reviewerGraceMinutes: 0 }));
  assert.equal(reviews(readied), 0, 'reviewerGraceMinutes 0 does not wait');
  assert.equal(reviews(readied, {}, '--grace', '10'), 3, '--grace overrides the project setting');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), reviewerGraceMinutes: 10 }));
  assert.equal(reviews({ ...readied, readyEvents: { nodes: [{ createdAt: minutesAgo(5) }] }, ...pr({ pushed: 5 }), isDraft: false, createdAt: readied.createdAt }), 3, 'A longer project grace waits longer than the default');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), reviewerGraceMinutes: '0' }));
  assert.equal(reviews(readied), 2, 'A malformed setting is an error, never silently the default');
  writeFileSync(config, plain);
});


test('reviews reads CI checks, check suites and the traces of reviewers on the head', t => {
  const { checkout, run, minutesAgo, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE')] })), 1, 'Red CI ends the wait as FAILED, never DONE');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'SKIPPED')] })), 0);
  assert.equal(reviews(pr({ contexts: [check('IN_PROGRESS')] })), 3);
  assert.equal(reviews(pr({ pushed: 60, contexts: [check('IN_PROGRESS')] })), 3, 'Running CI never stalls');
  writeFileSync(join(checkout, 'activity.json'), JSON.stringify([{ after: 'abcdef1234', timestamp: minutesAgo(1) }]));
  assert.equal(reviews(pr({ contexts: [] })), 3, 'CI that has not started yet waits for the first minutes');
  rmSync(join(checkout, 'activity.json'));
  assert.equal(reviews(pr({ pushed: 60, contexts: [] })), 1, 'A CLEAN head without any check ten minutes after its push is a blocker, not an endless wait (#947)');
  assert.equal(reviews(pr(), { comments: [codex('Running', 1)] }), 3, 'A running summary for the head waits');
  assert.equal(reviews(pr(), { comments: [codex('Completed', 0)] }), 0);
  assert.equal(reviews(pr(), { comments: [codex('Running', 60)] }), 0, 'A review running past the usual duration stalls');
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0)] }), 3, 'An announced review waits');
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0.5), reaction('+1', 0)] }), 0, 'A later reaction by the same bot is its result');
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 30)] }, '--stall', '120'), 0, 'Traces from before the push do not count');
  assert.equal(reviews(pr({ requests: ['maintainer'] })), 3, 'An outstanding review request waits');
  assert.equal(reviews(pr({ pushed: 60, requests: ['maintainer'] })), 0, 'An unanswered request stalls');
  // Older than the Running row, so they fill the first page without answering it.
  const many = Array.from({ length: 100 }, (_, index) => ({ ...codex('Completed', 5), html_url: `old-${index}` }));
  assert.equal(reviews(pr(), { comments: [...many, codex('Running', 1)] }), 3, 'Comments beyond the first page are read');
  assert.equal(reviews(pr({ total: 2 })), 2, 'Unreadable checks are never done');
  const request = { id: 1, user: { login: 'maintainer', type: 'User' }, body: '@codex review', html_url: 'c', created_at: minutesAgo(0.5), updated_at: minutesAgo(0.5) };
  assert.equal(reviews(pr(), { comments: [request], commentReactions: [reaction('eyes', 0)] }), 3, 'A 👀 on the review request comment waits');
  const note = { ...request, body: 'Deploy preview is ready' };
  assert.equal(reviews(pr(), { comments: [note], commentReactions: [reaction('eyes', 0)] }), 0, 'A 👀 on an unrelated comment is no trace');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), suite('QUEUED', 0, 1)] })), 3, 'A workflow that has not reported yet waits');
  assert.equal(reviews(pr({ pushed: 60, suites: [suite('COMPLETED', 1, 60), suite('QUEUED', 0, 60)] })), 0, 'A suite that never runs stalls');
  assert.equal(reviews(pr({ suiteTotal: 101 })), 2, 'Unreadable check suites are never done');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), suite('COMPLETED', 0, 1, 'STARTUP_FAILURE')] })), 1, 'A workflow that fails to start is FAILED');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE'), check('IN_PROGRESS')] })), 1, 'A known failure ends the wait while other checks run');
  // Draft then Ready: the first run's suite is cancelled before it reports a check run, the second run's suite carries them.
  const cancelled = suite('COMPLETED', 0, 1, 'CANCELLED', 10);
  assert.equal(reviews(pr({ suites: [cancelled] })), 1, 'A single empty cancelled suite is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'SUCCESS', 11)] }), {}, '--grace', '0'), 0, 'A newer successful suite of the same workflow replaces it');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1, 'SUCCESS', 11), cancelled] }), {}, '--grace', '0'), 0, 'The order of the suites does not matter');
  assert.equal(reviews(pr({ suites: [cancelled, suite('QUEUED', 0, 1, null, 11)] })), 3, 'A newer suite that has not reported yet waits');
  // The replacing suite answers for the workflow even with runs: the green rollup shows only the jobs reported so far.
  assert.equal(reviews(pr({ suites: [cancelled, suite('IN_PROGRESS', 1, 1, null, 11)] })), 3, 'A replacing suite with runs that is still running waits');
  assert.equal(reviews(pr({ pushed: 60, suites: [suite('COMPLETED', 0, 60, 'CANCELLED', 10), suite('IN_PROGRESS', 1, 60, null, 11)] })), 3, 'A running suite with runs never stalls');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'CANCELLED', 11)] })), 1, 'A replacing suite with runs that ends cancelled is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 0, 1, 'CANCELLED', 11)] })), 1, 'A newest cancelled suite is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 0, 1, 'STARTUP_FAILURE', 11)] })), 1, 'A newer suite that fails to start is a failure');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 0, 1, 'STARTUP_FAILURE', 10)] })), 1, 'A startup failure without a replacement is a failure');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'SUCCESS', 11, 'W-Other')] })), 1, 'Another workflow does not replace it');
  assert.equal(reviews(pr({ suites: [cancelled, suite('COMPLETED', 1, 1, 'SUCCESS', 11, 'W-Frontend', 'other-app')] })), 1, 'Another app does not replace it');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 0, 1, 'CANCELLED', 12), suite('COMPLETED', 1, 1, 'SUCCESS', 11)] })), 1, 'An older successful suite does not replace a newer cancelled one');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 0, 1, 'CANCELLED'), suite('COMPLETED', 1, 1, 'SUCCESS', 11)] })), 1, 'A suite without a workflow run cannot be ordered and stays a failure');
  // A pending approval beside a green run of the same workflow replaces nothing and is no failure; alone it still blocks.
  const approval = suite('COMPLETED', 0, 1, 'ACTION_REQUIRED', 12);
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1, 'SUCCESS', 11), approval] }), {}, '--grace', '0'), 0, 'A pending approval beside a green run of the same workflow is not red');
  assert.equal(reviews(pr({ suites: [approval] })), 1, 'A pending approval alone is a failure');
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1, 'SUCCESS', 11, 'W-Other'), approval] })), 1, 'A green run of another workflow does not excuse it');
});


test('reviews reports a moved base with the files both sides changed and never blocks on it', t => {
  const { checkout, run } = fixture(t);
  const look = (moved, changes) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr(changes)));
    if (moved === 'unreadable') writeFileSync(join(checkout, 'compare.json'), 'unreadable');
    else if (moved) writeFileSync(join(checkout, 'compare.json'), JSON.stringify(moved));
    else rmSync(join(checkout, 'compare.json'), { force: true });
    return run('reviews', '7');
  };
  const quiet = look(undefined);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.doesNotMatch(quiet.stdout, /base moved/, 'A base that did not move says nothing');
  assert.doesNotMatch(look({ behind: 0, own: ['a'], base: ['a'] }).stdout, /base moved/);

  const moved = look({ behind: 3, own: ['a.mjs', 'b.mjs'], base: ['b.mjs', 'c.mjs'] });
  assert.equal(moved.status, 0, 'A moved base never changes the verdict');
  assert.match(moved.stdout, /base moved: 3 commits since merge-base/);
  assert.match(moved.stdout, /changed on both sides: b\.mjs$/m);
  assert.match(look({ behind: 1, own: ['a.mjs'], base: ['c.mjs'] }).stdout, /no file is changed on both sides/);

  // More than 100 files come on one page (GitHub's cap is 300), and more shared files than are listed.
  const many = Array.from({ length: 150 }, (_, index) => `file-${index}`);
  assert.match(look({ behind: 1, own: many, base: ['file-149'] }).stdout, /changed on both sides: file-149$/m);
  assert.match(look({ behind: 1, own: many.slice(0, 12), base: many.slice(0, 12) }).stdout, /, and 2 more$/m);

  // A red head reports the movement too: that is when the next push is weighed.
  const red = handoffPr().commits.nodes[0].commit;
  const failed = look({ behind: 2, own: ['a'], base: ['a'] }, { commits: { nodes: [{ commit: { ...red, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
    { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }] } } } }] } });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /base moved: 2 commits/);

  // A branch name with "#" must reach GitHub whole.
  assert.match(look({ behind: 1, own: ['a'], base: ['a'] }, { baseRefName: 'topic#1' }).stdout, /base moved: 1 commits since merge-base \(topic#1\)/);

  const unreadable = look('unreadable');
  assert.equal(unreadable.status, 0, 'An unreadable comparison keeps the verdict');
  assert.match(unreadable.stdout, /note: base movement unreadable/);
});
