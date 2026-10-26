import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeReview } from '../review-verdict.mjs';
import { sonarIssues, SonarOtherPr } from '../sonar.mjs';

// The verdict reads nothing: a plain facts object and the settings decide.
const now = Date.parse('2026-01-01T12:00:00Z');
const ago = minutes => new Date(now - minutes * 60_000).toISOString();
const job = (run, conclusion = 'SUCCESS', status = 'COMPLETED') => ({ __typename: 'CheckRun', name: 'Backend', status, conclusion: status === 'COMPLETED' ? conclusion : null,
  checkSuite: { databaseId: run * 10, app: { slug: 'github-actions' }, workflowRun: { databaseId: run, workflow: { id: 'W' } } } });
const sonarCheck = { __typename: 'CheckRun', name: 'Sonar', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { slug: 'sonarqubecloud' } } };
const bot = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
const facts = ({ contexts = [job(1)], pr = {}, ...rest } = {}) => ({
  pr: { number: 7, state: 'OPEN', isDraft: false, baseRefName: 'main', headRefOid: 'abcdef1234', mergeStateStatus: 'CLEAN', reviewDecision: null, createdAt: ago(60),
    latestOpinionatedReviews: { totalCount: 0, nodes: [] }, reviewRequests: { totalCount: 0, nodes: [] }, requestEvents: { totalCount: 0, nodes: [] },
    commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: ago(30), checkSuites: { totalCount: 0, nodes: [] }, statusCheckRollup: { contexts: { totalCount: contexts.length, nodes: contexts } } } }] },
    ...pr },
  pushLog: [{ after: 'abcdef1234', timestamp: ago(30) }], baseMovement: null, comments: [], reviewList: [], reactions: [], inline: [], threads: [], ...rest });
const judge = (given, settings = {}, options = {}) => judgeReview(given, settings, { stallMinutes: 20, now, graceMinutes: 0, ...options });

test('the verdict is done, red or waiting from the facts alone', () => {
  const rules = [
    ['green CI is done', facts(), { done: true, failed: false }],
    ['a failed job is red', facts({ contexts: [job(1, 'FAILURE')] }), { done: true, failed: true }],
    ['a newer green run replaces a cancelled one', facts({ contexts: [job(1, 'CANCELLED'), job(2)] }), { done: true, failed: false }],
    ['a newest cancelled run stays red', facts({ contexts: [job(1), job(2, 'CANCELLED')] }), { done: true, failed: true }],
    ['a running job waits', facts({ contexts: [job(1, null, 'IN_PROGRESS')] }), { done: false, failed: false }],
    ['a Draft is never done', facts({ pr: { isDraft: true } }), { done: true, failed: true }],
    ['a conflict is red', facts({ pr: { mergeStateStatus: 'DIRTY' }, conflictLine: 'conflict' }), { done: true, failed: true }],
    ['a closed PR ends the wait without delivery', facts({ pr: { state: 'CLOSED' } }), { done: true, failed: true }],
  ];
  for (const [label, given, expected] of rules) {
    const verdict = judge(given);
    assert.deepEqual({ done: verdict.done, failed: verdict.failed }, expected, label);
  }
});

test('an unfinished bot review waits, then stalls after the usual duration', () => {
  const running = minutes => facts({ comments: [{ id: 1, user: bot, html_url: 'u', created_at: ago(minutes), updated_at: ago(minutes),
    body: `| Code Review | Running <relative-time datetime="${ago(minutes)}"></relative-time> | \`abcdef1\` |` }] });
  assert.equal(judge(running(5)).done, false);
  const stalled = judge(running(25));
  assert.equal(stalled.done, true);
  assert.match(stalled.lines.join('\n'), /^stalled: chatgpt-codex-connector running/m);
  // The grace waits for a silent reviewer until it has passed.
  assert.equal(judge(facts({ pushLog: [{ after: 'abcdef1234', timestamp: ago(1) }] }), {}, { graceMinutes: 5 }).done, false);
  assert.equal(judge(facts(), {}, { graceMinutes: 5 }).done, true);
});

test('an optional reviewer is shown and never awaited', () => {
  const eyes = facts({ reactions: [{ content: 'eyes', created_at: ago(2), user: { login: 'coderabbitai[bot]', type: 'Bot' } }] });
  assert.equal(judge(eyes).done, false);
  assert.equal(judge(eyes, { optionalReviewers: ['coderabbitai'] }).done, true);
});

test('a pending status of an optional reviewer is awaited for ten minutes after the push, a missing one never (#1030)', () => {
  const settings = { optionalReviewers: ['coderabbitai'] };
  const rabbit = (state, description = 'Review in progress') => ({ __typename: 'StatusContext', context: 'CodeRabbit', state, description, creator: { login: 'coderabbitai' } });
  const given = (minutes, ...extra) => {
    const contexts = [job(1), ...extra], base = facts({ contexts });
    const commit = { ...base.pr.commits.nodes[0].commit, committedDate: ago(minutes) };
    return { ...base, pr: { ...base.pr, commits: { nodes: [{ commit }] } } };
  };
  assert.equal(judge(given(2, rabbit('PENDING')), settings).done, false, 'a fresh pending review is awaited');
  assert.equal(judge(given(12, rabbit('PENDING')), settings).done, true, 'after the time limit it is shown only');
  assert.equal(judge(given(2), settings).done, true, 'no review at all: nothing to wait for');
  assert.equal(judge(given(2, rabbit('PENDING', 'Review rate limited')), settings).done, true, 'a rate limit is no running review');
});

test('a Draft skip of a check listed in ignoredChecks waits for nothing (#887)', () => {
  // A Backend run skipped while Draft (after the Draft conversion, before Ready) and no run since Ready.
  const draftSkip = { __typename: 'CheckRun', name: 'Backend', status: 'COMPLETED', conclusion: 'SKIPPED',
    checkSuite: { createdAt: ago(10), databaseId: 100, app: { slug: 'github-actions' }, workflowRun: { databaseId: 10, event: 'pull_request', workflow: { id: 'W' } } } };
  const draft = facts({ contexts: [draftSkip], pr: { convertEvents: { nodes: [{ createdAt: ago(20) }] }, readyEvents: { nodes: [{ createdAt: ago(5) }] } } });
  assert.equal(judge(draft).done, false, 'Without ignoredChecks the Draft skip still waits for a run since Ready');
  assert.equal(judge(draft, { ignoredChecks: ['Backend'] }).done, true);
  assert.equal(judge(draft, { ignoredChecks: ['Lint'] }).done, false, 'A check not listed still waits');
});

test('open Sonar issues are red, a failed read throws', () => {
  const withSonar = answer => facts({ contexts: [job(1), sonarCheck], sonar: new Map([[sonarCheck, answer]]) });
  assert.equal(judge(withSonar({ total: 0, lines: [] })).failed, false);
  const open = judge(withSonar({ total: 2, lines: ['sonar: rule A.java:1 m'] }));
  assert.deepEqual([open.failed, open.reasons], [true, ['2 open Sonar issues']]);
  assert.throws(() => judge(withSonar({ error: new Error('Sonar API answered 401') })), /401/);
});

test('a listed analyzer with no suite at all waits, then fails, and an optional one never does (#1060)', () => {
  const missing = (settings, pushedMinutesAgo) => judge(facts({ pr: { commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: ago(pushedMinutesAgo), checkSuites: { totalCount: 0, nodes: [] },
    statusCheckRollup: { contexts: { totalCount: 1, nodes: [job(1)] } } } }] } }, pushLog: [{ after: 'abcdef1234', timestamp: ago(pushedMinutesAgo) }] }), settings);
  const listed = { awaitApps: ['sonarqubecloud'] };
  assert.equal(missing(listed, 5).done, false, 'young head: still waiting');
  const stalledVerdict = missing(listed, 30);
  assert.equal(stalledVerdict.failed, true);
  assert.match(stalledVerdict.reasons.join('\n'), /sonarqubecloud missing/);
  const present = judge(facts({ pr: { commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: ago(30), checkSuites: { totalCount: 1, nodes: [{ app: { slug: 'sonarqubecloud' }, status: 'COMPLETED', conclusion: 'SUCCESS', checkRuns: { totalCount: 1 } }] },
    statusCheckRollup: { contexts: { totalCount: 1, nodes: [job(1)] } } } }] } } }), { awaitApps: ['app/SonarQubeCloud'] });
  assert.equal(present.failed, false, 'a suite counts under any spelling of the listed name');
  assert.equal(missing({}, 30).failed, false, 'a project that lists no analyzer is unaffected');
  assert.equal(missing({ ...listed, optionalReviewers: ['sonarqubecloud'] }, 30).failed, false);
});

test('a cancelled Sonar analysis stays red, with 0 findings too (#1060)', () => {
  const cancelled = { ...sonarCheck, conclusion: 'CANCELLED' };
  const withCancelled = answer => judge(facts({ contexts: [job(1), cancelled], sonar: new Map([[cancelled, answer]]) }));
  assert.equal(withCancelled({ total: 0, lines: [] }).failed, true);
  assert.match(withCancelled({ total: 0, lines: [] }).reasons.join('\n'), /re-run the Sonar check/);
  const unreadable = withCancelled({ error: new Error('Sonar API answered 404') }); // no read is made, so no throw hides the hint
  assert.deepEqual(unreadable.reasons.filter(reason => /Sonar/.test(reason)), [unreadable.reasons.find(reason => /re-run the Sonar check/.test(reason))]);
  assert.equal(judge(facts({ contexts: [job(1), job(2, 'CANCELLED')] })).failed, true);
});

test('a change request is dismissed only on handoff, once all threads are resolved', () => {
  const requested = { author: { login: 'coderabbitai' }, state: 'CHANGES_REQUESTED' };
  const stale = threads => facts({ threads, pr: { latestOpinionatedReviews: { totalCount: 1, nodes: [requested] } },
    reviewList: [{ id: 9, user: { login: 'coderabbitai[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'old' }] });
  const settings = { optionalReviewers: ['coderabbitai'] };
  assert.equal(judge(stale([]), settings).dismissals.length, 0);
  // #1002: the wait before the handoff (done) must not read the answered request as a blocker, or handoff never gets to dismiss it.
  const waiting = judge(stale([]), settings).lines;
  assert.ok(!waiting.some(line => line.startsWith('blocker:')), waiting.join('\n'));
  assert.ok(waiting.includes('stale change request by coderabbitai: all threads are resolved, dismissed on handoff'));
  // A person's request, an unanswered one and a non-optional bot's keep blocking.
  assert.ok(judge(stale(['t']), settings).lines.includes('blocker: changes requested by coderabbitai'));
  assert.ok(judge(stale([])).lines.includes('blocker: changes requested by coderabbitai'));
  assert.deepEqual(judge(stale([]), settings, { dismissStale: true }).dismissals.map(({ id }) => id), [9]);
  assert.equal(judge(stale(['t']), settings, { dismissStale: true }).dismissals.length, 0);
});

test('the Sonar door reads only the linked analysis and never reads an unreadable count as clean', t => {
  const token = process.env.SONAR_TOKEN;
  process.env.SONAR_TOKEN = '';
  t.after(() => { if (token === undefined) delete process.env.SONAR_TOKEN; else process.env.SONAR_TOKEN = token; });
  assert.throws(() => sonarIssues('http://127.0.0.1/d?id=k&pullRequest=7', 7), /does not link PR #7/);
  assert.throws(() => sonarIssues('https://sonarcloud.io/d?id=k&pullRequest=8', 7), SonarOtherPr);
  // #1055: without a token the `sonar` CLI lists the issues; a missing CLI is one line, never "0 New issues" of a check summary.
  const path = process.env.PATH;
  process.env.PATH = '';
  t.after(() => { process.env.PATH = path; });
  assert.throws(() => sonarIssues('https://sonarcloud.io/d?id=k&pullRequest=7', 7), /Sonar is unreachable: SONAR_TOKEN is not set/);
});

test('an open thread line names the number that `board.mjs threads` takes', () => {
  const lines = judge(facts({ threads: ['https://github.com/test/example/pull/7#discussion_r555', 'thread-0'] })).lines;
  assert.ok(lines.includes('thread https://github.com/test/example/pull/7#discussion_r555 (board.mjs threads 7 --resolve 555)'));
  assert.ok(lines.includes('thread thread-0'), 'A link without a number stays as it was');
});
