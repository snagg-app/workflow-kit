import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewsFixture, test } from './board-fixture.mjs';


test('reviews tells the newest run of a job from cancelled, skipped and Draft runs', t => {
  const { checkout, run, runBriefly, minutesAgo, job, draftRun, readyHead, oldTraces, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED')] })), 1, 'A single cancelled run is a failure');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'COMPLETED')] })), 0, 'A cancelled run followed by a green one is no failure');
  assert.equal(reviews(pr({ contexts: [job(2, 'COMPLETED'), job(1, 'COMPLETED', 'CANCELLED')] })), 0, 'The order of the list does not matter');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED'), job(2, 'COMPLETED', 'CANCELLED')] })), 1, 'A newest cancelled run is a failure');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'IN_PROGRESS')] })), 3, 'A cancelled run followed by a running one waits');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED', 'Backend'), job(2, 'COMPLETED', 'SUCCESS', 'Lint')] })), 1, 'Another job does not replace it');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'COMPLETED', 'SUCCESS', 'Backend', 'Frontend')] })), 1, 'The same job name in another workflow does not replace it');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED', 'Backend', 'Build', 'W-1'), job(2, 'COMPLETED', 'SUCCESS', 'Backend', 'Build', 'W-2')] })), 1,
    'Two workflows with the same display name and job name stay two jobs');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED', 'Backend', 'Build', 'W-1'), job(2, 'COMPLETED', 'SUCCESS', 'Backend', 'Build', 'W-1')] })), 0,
    'Runs of one workflow id are one job');
  // Jobs of one workflow run never replace each other, even with the same display name; a later run replaces earlier ones.
  assert.equal(reviews(pr({ contexts: [job(10, 'COMPLETED', 'FAILURE'), job(10, 'COMPLETED', 'SUCCESS')] })), 1,
    'Two jobs with one display name in the same run: a success does not hide the failure');
  assert.equal(reviews(pr({ contexts: [job(10, 'COMPLETED', 'CANCELLED', 'Lint'), job(10, 'COMPLETED', 'SUCCESS', 'Test'),
    job(11, 'COMPLETED', 'SUCCESS', 'Lint'), job(11, 'COMPLETED', 'SUCCESS', 'Test')] })), 0,
    'A complete newer run supersedes the cancelled run of the earlier one');
  assert.equal(reviews(pr({ contexts: [job(10, 'COMPLETED', 'SUCCESS'), job(11, 'COMPLETED', 'FAILURE'), job(11, 'COMPLETED', 'SUCCESS')] })), 1,
    'A failing job of the newest run stays a failure next to a same-named success');
  // A SKIPPED run executed nothing: it neither replaces nor hides an earlier run of the same job.
  const skipped = run => job(run, 'COMPLETED', 'SKIPPED');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2)] })), 1, 'A cancelled run followed by a fully skipped one has no proof');
  assert.equal(reviews(pr({ contexts: [skipped(2), job(1, 'COMPLETED', 'CANCELLED')] })), 1, 'The order of the list does not matter');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'FAILURE'), skipped(2)] })), 1, 'A failure is not hidden by a later skipped run');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED'), skipped(2)] })), 0, 'A real success of the same head stays proof next to a skipped run');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2), job(3, 'COMPLETED')] })), 0, 'A successful retry run is the proof');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2), job(3, 'COMPLETED', 'FAILURE')] })), 1, 'A failed retry stays failed');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), skipped(2), job(3, 'IN_PROGRESS')] })), 3, 'A running retry waits');
  assert.equal(reviews(pr({ contexts: [job(1, 'IN_PROGRESS'), skipped(2)] })), 3, 'A skipped run does not hide a running one');
  assert.equal(reviews(pr({ contexts: [skipped(1), skipped(2)] })), 0, 'A job that was only ever skipped is optional');
  assert.equal(reviews(pr({ contexts: [skipped(1), job(2, 'COMPLETED', 'SUCCESS', 'Lint')] })), 0, 'A skipped optional job next to a real success passes');
  assert.equal(reviews(pr({ contexts: [job(1, 'COMPLETED', 'CANCELLED'), job(2, 'COMPLETED', 'SKIPPED', 'Backend', 'Frontend')] })), 1,
    'A skipped run of another workflow does not stand in for it');
  assert.equal(reviews(readyHead([draftRun(1)]), oldTraces), 3, 'A Ready head whose only runs were skipped while Draft is not proof');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SKIPPED', { name: 'Lint', workflow: 'Lint' }), job(3, 'COMPLETED', 'SUCCESS', 'Backend', 'Frontend')]), oldTraces), 3,
    'A green other workflow does not cover the missing path');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'IN_PROGRESS', { minutes: 2 })]), oldTraces), 3, 'A running Ready run waits');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'FAILURE', { minutes: 2 })]), oldTraces), 1, 'A failed Ready run is FAILED');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { minutes: 2 })]), oldTraces), 0, 'An executed Ready run is the proof');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SKIPPED', { minutes: 2 })]), oldTraces), 0, 'A skip after Ready is a real optional skip');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { name: 'Lint', minutes: 2 })]), oldTraces), 0, 'A skipped job of a workflow that executed since Ready stays optional');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { name: 'Lint' })]), oldTraces), 3, 'An unguarded job that ran while Draft does not cover the guarded one');
  // Converting to Draft right before Ready starts a Draft run that can land just after the Ready event.
  const toggled = contexts => readyHead(contexts, { convertEvents: { nodes: [{ createdAt: minutesAgo(5.02) }] } });
  const lateSkip = () => draftRun(1, 'SKIPPED', { minutes: 4.95 });
  assert.equal(reviews(toggled([lateSkip()]), oldTraces), 3, 'A Draft-conversion run just after Ready is no Ready proof');
  assert.equal(reviews(toggled([draftRun(1, 'SKIPPED', { minutes: 20 })]), oldTraces), 0, 'A skip from before the latest Draft conversion belongs to an earlier period');
  assert.equal(reviews(readyHead([lateSkip()]), oldTraces), 0, 'Precondition: without the conversion that skip is after Ready');
  assert.equal(reviews(toggled([lateSkip(), draftRun(2, 'SUCCESS', { minutes: 3 })]), oldTraces), 0, 'A later executed run of the workflow is the proof');
  // Opened as Draft (Ready event, no conversion) and marked Ready within seconds: the delayed `opened` run is a Draft run too.
  const openedDraft = contexts => readyHead(contexts, { createdAt: minutesAgo(5.05) });
  assert.equal(reviews(openedDraft([lateSkip()]), oldTraces), 3, 'An opened-as-Draft run just after Ready is no Ready proof');
  assert.equal(reviews(openedDraft([lateSkip(), draftRun(2, 'SUCCESS', { minutes: 3 })]), oldTraces), 0, 'A later executed run of the workflow is the proof');
  assert.equal(reviews(readyHead([lateSkip()], { createdAt: 'unreadable' }), oldTraces), 2, 'An unreadable creation time is an error, never proof');
  // Ready two seconds after opening as Draft: the executed run created just after the Ready event is a Ready run, though inside the 10 s window.
  const quickReady = contexts => readyHead(contexts, { createdAt: minutesAgo(5 + 2 / 60) });
  assert.equal(reviews(quickReady([draftRun(1, 'SKIPPED', { minutes: 5 + 1 / 60 }), draftRun(2, 'SUCCESS', { minutes: 5 - 2 / 60 })]), oldTraces), 0, 'A run executed just after a quick Ready is the proof');
  assert.equal(reviews(quickReady([draftRun(1, 'SKIPPED', { minutes: 5 + 1 / 60 }), draftRun(2, 'SKIPPED', { minutes: 5 - 2 / 60 })]), oldTraces), 3, 'A skip just after a quick Ready stays a Draft skip');
  // #940: pull_request_target does not start on Ready by default (opened, synchronize, reopened), so its skip from opening never gets a Ready run and must not make wait lag.
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: 'pull_request_target', minutes: 25 }), draftRun(2, 'SKIPPED', { name: 'Lint', workflow: 'Lint', event: 'pull_request', minutes: 25 }), draftRun(3, 'SUCCESS', { name: 'Lint', workflow: 'Lint', minutes: 2 })]), oldTraces), 0,
    'A pull_request_target skip with no Ready run does not wait (skipped in Draft, green after Ready)');
  // A pull_request workflow that does not start on Ready (path filter, no ready_for_review) leaves its skip from opening as the only run: wait waits a while, then notes it.
  const noReadyRun = { event: 'pull_request', minutes: 25 };
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', noReadyRun)]), oldTraces), 3, 'Precondition: shortly after Ready the missing run may still start');
  const longReady = readyHead([draftRun(1, 'SKIPPED', noReadyRun)], { readyEvents: { nodes: [{ createdAt: minutesAgo(11) }] } });
  assert.equal(reviews(longReady, oldTraces), 0, 'A skip from opening with no run after Ready for 10 minutes does not wait forever');
  assert.match(look(longReady, oldTraces).stdout, /^note: check Backend was skipped while Draft; no run since Ready/m, 'The ended wait is still shown');
  assert.equal(reviews(readyHead([draftRun(1, 'SUCCESS', { event: 'push' }), draftRun(2)]), oldTraces), 3, 'An executed push run of the same job from before Ready does not hide the Draft skip');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: null, minutes: 2 })]), oldTraces), 0, 'A skip after Ready needs no readable event');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: 'push' })]), oldTraces), 0, 'Only pull_request runs carry a Draft guard');
  assert.equal(reviews({ ...readyHead([draftRun(1)]), isDraft: true }, oldTraces), 1, 'A Draft head is never DONE');
  assert.equal(reviews({ ...readyHead([draftRun(1)]), readyEvents: { nodes: [] } }, oldTraces), 0, 'A PR that was never Draft has no Draft runs');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { time: 'unreadable' })]), oldTraces), 2, 'An unreadable run time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { event: null })]), oldTraces), 2, 'An unreadable run event is an error, never proof');
  assert.equal(reviews({ ...readyHead([draftRun(1)]), readyEvents: { nodes: [{ createdAt: 'unreadable' }] } }, oldTraces), 2, 'An unreadable Ready time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1)], { convertEvents: { nodes: [{ createdAt: 'unreadable' }] } }), oldTraces), 2, 'An unreadable Draft conversion time is an error, never proof');
  assert.equal(reviews(readyHead([draftRun(1), draftRun(2, 'SUCCESS', { name: 'Lint', time: 'unreadable' })]), oldTraces), 2, 'An unreadable start time of a sibling run is an error, never a silent wait');
  assert.equal(reviews(readyHead([draftRun(1, 'SKIPPED', { time: 'unreadable' }), job(2, 'COMPLETED', 'FAILURE', 'Lint', 'Lint')]), oldTraces), 1, 'A known failure stays the verdict over unreadable Draft data');
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE')] })), 1, 'A later read failure keeps the known CI verdict');
  rmSync(join(checkout, 'fail-rest'));
});


test('reviews reads Codex rows, blockers and threads, and wait ends with the verdict', t => {
  const { checkout, run, runBriefly, minutesAgo, draftRun, readyHead, oldTraces, codexUser, check, suite, pr, codex, reaction, look, reviews } = reviewsFixture(t);
  let commentId = 1000; // after the ids of `codex`, so no two comments share one
  const headReview = { user: codexUser, commit_id: 'abcdef1234', state: 'COMMENTED', html_url: 'r', submitted_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { comments: [codex('Running', 1)], reviewList: [headReview] }), 0, 'A head review ends a Running summary');
  assert.equal(reviews(pr(), { comments: [{ ...codex('Running', 3), updated_at: minutesAgo(0) }] }), 3, 'A later edit of the summary itself is no result');
  // Codex reviews code and security side by side: one summary, one row per kind, and a separate security result comment.
  const summary = (rows, commit = 'abcdef1') => ({ id: ++commentId, user: codexUser, html_url: 'u', created_at: minutesAgo(10), updated_at: minutesAgo(1),
    body: `| Review | Status | Commit |\n${rows.map(([kind, status, minutes]) =>
      `| ${kind} | ${status} <relative-time datetime="${minutesAgo(minutes)}"></relative-time> | \`${commit}\` |`).join('\n')}` });
  const securityResult = minutes => ({ id: ++commentId, user: codexUser, html_url: 's', created_at: minutesAgo(minutes), updated_at: minutesAgo(minutes),
    body: '### 🛡️ Codex Security Review\n\nSecurity review completed. No security issues were found.' });
  const both = [['📝 **Code Review**', '⏳ **Running**', 3], ['🔒 **Security Review**', '⏳ **Running**', 3]];
  assert.equal(reviews(pr(), { comments: [summary(both)] }), 3, 'Both kinds running wait');
  assert.equal(reviews(pr(), { comments: [summary(both), securityResult(0)] }), 3, 'A security result leaves the running code review waiting');
  assert.equal(reviews(pr(), { comments: [summary(both), securityResult(0)], reviewList: [headReview] }), 0, 'Both results end both rows');
  assert.equal(reviews(pr(), { comments: [summary([both[1]]), securityResult(0)] }), 0, 'A security result ends a running security row');
  assert.equal(reviews(pr(), { comments: [summary(both)], reviewList: [headReview] }), 3, 'A code review leaves the running security review waiting');
  assert.equal(reviews(pr(), { comments: [summary(both), securityResult(5)] }), 3, 'A security result from before the row started answers nothing');
  assert.equal(reviews(pr(), { comments: [summary(both)], reactions: [reaction('+1', 0)] }), 0, 'A final reaction ends every kind');
  assert.equal(reviews(pr(), { comments: [summary(both, 'previous')] }), 0, 'Rows for another commit are not traces on this head');
  const appSuite = { ...suite('QUEUED', 0, 1), app: { slug: 'sonarqubecloud' } };
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), appSuite] }), {}, '--grace', '0'), 0, 'Idle suites of other apps are no trace');
  const blocked = look({ ...pr(), mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED',
    latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'coderabbitai' } }] } });
  assert.equal(blocked.status, 0, 'Blockers are for the handoff; the wait itself is over');
  assert.match(blocked.stdout, /^blocker: changes requested by coderabbitai$/m, 'A standing change request is named as a blocker');
  assert.match(look({ ...pr(), mergeStateStatus: 'DIRTY' }).stdout, /^blocker: merge conflicts$/m);
  assert.equal(reviews({ ...pr(), latestOpinionatedReviews: { totalCount: 101, nodes: [] } }), 2, 'Cut-off review decisions are never read as no blocker');
  const config = join(checkout, '.github/workflow-project.json'), plain = readFileSync(config, 'utf8');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), awaitApps: ['sonarqubecloud'] }));
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), appSuite] })), 3, 'A listed analyzer waits until it reports');
  writeFileSync(config, plain);
  // An optional reviewer (a bot on a free plan that is mostly rate limited) is shown but never awaited, stalled or red.
  const rabbit = { login: 'coderabbitai[bot]', type: 'Bot' };
  const rabbitStatus = (state, description = 'Review rate limited') => ({ __typename: 'StatusContext', context: 'CodeRabbit', state, description, creator: { login: 'coderabbitai' } });
  const rabbitRunning = { ...codex('Running', 0.5), user: rabbit };
  const rabbitRequest = { requestedReviewer: { __typename: 'Bot', login: 'coderabbitai' } };
  const rabbitTraces = [
    [pr({ contexts: [check('COMPLETED'), rabbitStatus('PENDING')] }), {}],
    [pr({ contexts: [check('COMPLETED'), rabbitStatus('FAILURE')] }), {}],
    [pr({ contexts: [check('COMPLETED'), { ...check('IN_PROGRESS'), name: 'CodeRabbit', checkSuite: { app: { slug: 'coderabbitai' } } }] }), {}],
    [pr(), { comments: [rabbitRunning] }],
    [pr(), { reactions: [{ ...reaction('eyes', 0), user: rabbit }] }],
    [{ ...pr(), reviewRequests: { totalCount: 1, nodes: [rabbitRequest] }, requestEvents: { totalCount: 0, nodes: [] } }, {}]];
  const waitingFor = [3, 1, 3, 3, 3, 3];
  rabbitTraces.forEach(([data, traces], index) => assert.equal(reviews(data, traces), waitingFor[index], `Precondition: unlisted trace ${index} decides`));
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: [' CodeRabbitAI[bot] '] }));
  rabbitTraces.forEach(([data, traces], index) => assert.equal(reviews(data, traces), 0, `Optional reviewer trace ${index} never waits or fails`));
  assert.equal(reviews(pr({ pushed: 60, contexts: [check('IN_PROGRESS')] })), 3, 'Other checks still wait');
  assert.equal(reviews(pr({ contexts: [check('COMPLETED', 'FAILURE'), rabbitStatus('SUCCESS')] })), 1, 'A listed reviewer does not hide red CI');
  assert.equal(reviews(pr({ requests: ['maintainer'] })), 3, 'Other review requests still wait');
  assert.match(look(rabbitTraces[0][0], rabbitTraces[0][1]).stdout, /^check CodeRabbit: pending/m, 'The optional trace is still shown');
  assert.match(look(pr(), { comments: [rabbitRunning] }).stdout, /^comment coderabbitai /m, 'Optional comments are still listed');
  const optionalFindings = look({ ...pr({ threadPages: [[false]] }), mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED',
    latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'coderabbitai' } }] } });
  assert.match(optionalFindings.stdout, /^unresolved threads: 1$/m, 'An open thread of an optional reviewer still counts');
  assert.match(optionalFindings.stdout, /^blocker: changes requested by coderabbitai$/m, 'A change request of an optional reviewer still blocks');
  // A workflow run of an optional app that was skipped while Draft is no missing Ready run either.
  const rabbitDraftRun = draftRun(3, 'SKIPPED', { name: 'Review', workflow: 'Review' });
  const rabbitReadyHead = readyHead([{ ...rabbitDraftRun, checkSuite: { ...rabbitDraftRun.checkSuite, app: { slug: 'coderabbitai' } } }, draftRun(2, 'SUCCESS', { minutes: 2 })]);
  assert.equal(reviews(rabbitReadyHead, oldTraces), 0, 'A Draft-skipped run of an optional reviewer never waits');
  // The list names bots and apps: a team of the same name is still a required reviewer.
  const teamRequest = { ...pr(), reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { __typename: 'Team', name: 'coderabbitai' } }] }, requestEvents: { totalCount: 0, nodes: [] } };
  assert.equal(reviews(teamRequest), 3, 'A team with an optional name is no optional reviewer');
  assert.match(look(rabbitTraces[0][0]).stdout, /Review rate limited/, 'The optional trace keeps its description');
  writeFileSync(join(checkout, 'activity.json'), JSON.stringify([{ after: 'abcdef1234', timestamp: minutesAgo(1) }]));
  assert.equal(reviews(pr({ contexts: [rabbitStatus('SUCCESS')] })), 3, 'An optional check alone is no CI: the first CI check is still awaited');
  rmSync(join(checkout, 'activity.json'));
  assert.equal(reviews(pr({ contexts: [rabbitStatus('SUCCESS')] })), 1, 'A CLEAN head that got no CI check ten minutes after its push is a blocker (#947)');
  const rabbitSuite = { ...suite('QUEUED', 0, 1), app: { slug: 'coderabbitai' } };
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), awaitApps: ['coderabbitai'] }));
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), rabbitSuite] })), 3, 'Precondition: an awaited app that is not optional waits');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), awaitApps: ['coderabbitai'], optionalReviewers: ['app/CodeRabbitAI'] }));
  assert.equal(reviews(pr({ suites: [suite('COMPLETED', 1, 1), rabbitSuite] }), {}, '--grace', '0'), 0, 'An optional reviewer is never awaited, even when listed in awaitApps (gh spelling app/NAME)');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: 'coderabbitai' }));
  assert.equal(reviews(pr()), 2, 'A malformed list is an error, never silently ignored');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: null }));
  assert.equal(reviews(pr()), 2, 'null is malformed too; only a missing field is allowed');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: ['coderabbitai'] }));
  const optionalEyes = look(rabbitTraces[4][0], rabbitTraces[4][1]);
  assert.equal(optionalEyes.status, 0, 'An optional 👀 is no reason to wait');
  assert.match(optionalEyes.stdout, /^reaction coderabbitai /m, 'The optional 👀 is shown');
  writeFileSync(config, plain);
  assert.equal(reviews(pr({ contexts: [rabbitStatus('SUCCESS')] })), 0, 'Precondition: unlisted, the same lone status is CI');
  const sonar = { ...check('COMPLETED'), name: 'SonarCloud Code Analysis', summary: '[0 New issues]',
    detailsUrl: 'https://sonarcloud.io/dashboard?id=test_example&pullRequest=7', checkSuite: { app: { slug: 'sonarqubecloud' } } };
  const sonarOnly = look(pr({ contexts: [sonar] }));
  assert.equal(sonarOnly.status, 0, sonarOnly.stdout + sonarOnly.stderr);
  assert.doesNotMatch(sonarOnly.stdout, /failure notice/, 'The normal green run raises no contradiction');
  // A failure notice after the green check is shown, never a blocker: it names no revision (#570).
  const greenAt = { ...sonar, completedAt: minutesAgo(3) };
  const notice = (minutes, id = 501) => ({ id, user: { login: 'sonarqubecloud[bot]', type: 'Bot' }, html_url: `n${id}`, created_at: minutesAgo(minutes), updated_at: minutesAgo(minutes), body: 'The last analysis has failed.' });
  const contradicted = look(pr({ contexts: [greenAt] }), { comments: [notice(2)] });
  assert.match(contradicted.stdout, /^sonar: failure notice n501 came after the green check/m, 'A later notice is shown');
  assert.equal(contradicted.status, 0, 'A later notice does not block');
  assert.doesNotMatch(look(pr({ contexts: [greenAt] }), { comments: [notice(4)] }).stdout, /failure notice/, 'A notice before the green check is superseded');
  assert.doesNotMatch(look(pr({ contexts: [greenAt] }), { comments: [notice(7)] }).stdout, /failure notice/, 'A notice from before the push belongs to an older head');
  assert.equal(reviews(rabbitReadyHead, oldTraces), 3, 'Precondition: unlisted, the same Draft-skipped run waits');
  const oldHeadReview = { user: codexUser, commit_id: 'previous', state: 'COMMENTED', html_url: 'r', submitted_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0.5)], reviewList: [oldHeadReview] }), 3, 'A review of the previous head answers nothing');
  assert.equal(reviews(pr({ pushed: 60, requests: ['maintainer'], requestedAgo: 1 })), 3, 'A late review request starts its own clock');
  assert.equal(reviews(pr({ pushed: 60, requests: ['maintainer'], requestEventTotal: 101 })), 2, 'A request whose time is cut off fails closed');
  assert.equal(reviews({ ...pr(), state: 'CLOSED' }), 1, 'A PR closed without merge is FAILED');
  const inlineReply = { user: codexUser, html_url: 'i', created_at: minutesAgo(0), updated_at: minutesAgo(0) };
  assert.equal(reviews(pr(), { reactions: [reaction('eyes', 0.5)], inline: [inlineReply] }), 0, 'An inline review comment is the result');
  assert.match(look(pr(), { inline: [inlineReply] }).stdout, /^inline chatgpt-codex-connector i$/m, 'Inline findings are listed');
  const bigReview = look(pr({ threadPages: [Array(100).fill(true), [false]] }));
  assert.equal(bigReview.status, 0, 'More than 100 threads still get a verdict');
  assert.match(bigReview.stdout, /^unresolved threads: 1$/m, 'Threads on every page are counted');
  assert.match(bigReview.stdout, /^thread thread-1$/m, 'Every unresolved thread is linked, whatever head it is on');

  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr()));
  for (const file of ['issues-comments', 'issues-reactions', 'pulls-comments']) writeFileSync(join(checkout, `${file}.json`), '[]');
  assert.equal(run('wait', '7').status, 0, 'wait returns once the head is done');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr({ contexts: [check('COMPLETED', 'FAILURE')] })));
  const red = run('wait', '7');
  assert.equal(red.status, 1, 'wait ends as FAILED on red CI');
  assert.match(red.stdout, /^FAILED: check CI FAILURE$/m, 'the FAILED line names the red check');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr({ contexts: [check('IN_PROGRESS')] })));
  const waitBriefly = (...args) => runBriefly(3000, 'wait', '7', ...args);
  assert.match(waitBriefly(), /^WAITING\nwaiting: check CI/, 'A background wait shows what it waits for');
  assert.match(waitBriefly('--merged'), /^WAITING\nwaiting: human merge/);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr(), state: 'MERGED' }));
  assert.equal(run('wait', '7', '--merged').status, 0, 'wait --merged returns once the PR is merged');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr(), state: 'CLOSED' }));
  assert.equal(run('wait', '7', '--merged').status, 1, 'A PR closed without merge is FAILED, never delivered');
  writeFileSync(join(checkout, 'fail'), '');
  assert.equal(run('reviews', '7').status, 2);
  assert.equal(run('wait', '7').status, 2, 'wait reports a read failure instead of waiting silently');
});

test('reviews names the cause of a head without pull_request runs and an UNKNOWN merge state (#412)', t => {
  const { checkout, minutesAgo, check, pr, look } = reviewsFixture(t);
  const stuck = { ...pr({ contexts: [], suites: [] }), mergeStateStatus: 'UNKNOWN' };
  const pushedAgo = minutes => writeFileSync(join(checkout, 'activity.json'), JSON.stringify([{ after: 'abcdef1234', timestamp: minutesAgo(minutes) }]));
  const stuckAt = minutes => (pushedAgo(minutes), look(stuck));
  assert.equal(stuckAt(2).status, 3, 'A fresh push may still get its run');
  const outside = stuckAt(30);
  assert.equal(outside.status, 1, 'Pushed long ago, no run, UNKNOWN: a blocker, not a silent wait');
  assert.match(outside.stdout, /blocker: .*push an empty commit/, 'Outside a stack: the hint');
  writeFileSync(join(checkout, 'stacks.json'), JSON.stringify([{ number: 1 }]));
  assert.match(stuckAt(30).stdout, /blocker: .*native stack.*stack-sync/, 'In a stack: the cause and the command');
  writeFileSync(join(checkout, 'runs.json'), JSON.stringify([{ event: 'pull_request' }]));
  assert.equal(stuckAt(30).status, 3, 'A head with a run keeps waiting');
  assert.equal(look({ ...pr({ contexts: [check('IN_PROGRESS')] }), mergeStateStatus: 'UNKNOWN' }).status, 3, 'Running CI keeps waiting');
});

test('the review gate takes the reviewer lists from the PR base, not from the checkout (#448)', t => {
  const { checkout, reviews, pr } = reviewsFixture(t);
  const config = join(checkout, '.github/workflow-project.json'), plain = readFileSync(config, 'utf8'), base = join(checkout, 'base-project.json');
  // The base has a malformed list, the checkout does not: the base decides.
  writeFileSync(base, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: 'coderabbitai' }));
  assert.equal(reviews(pr()), 2, 'A malformed list on the base is an error');
  assert.equal(readFileSync(join(checkout, 'contents-refs'), 'utf8').trim(), 'release/0.1.1', 'The settings are read from the base of the PR');
  // A base that cannot be read is no reason to fall back to the checkout.
  writeFileSync(base, plain);
  writeFileSync(join(checkout, 'base-missing'), '');
  assert.equal(reviews(pr()), 2, 'An unreadable base fails closed');
});

