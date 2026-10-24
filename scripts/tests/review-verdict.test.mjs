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

test('a Draft skip of a check listed in ignoredChecks waits for nothing (#887)', () => {
  // A Backend run skipped while Draft (after the Draft conversion, before Ready) and no run since Ready.
  const draftSkip = { __typename: 'CheckRun', name: 'Backend', status: 'COMPLETED', conclusion: 'SKIPPED',
    checkSuite: { createdAt: ago(10), databaseId: 100, app: { slug: 'github-actions' }, workflowRun: { databaseId: 10, event: 'pull_request', workflow: { id: 'W' } } } };
  const draft = facts({ contexts: [draftSkip], pr: { convertEvents: { nodes: [{ createdAt: ago(20) }] }, readyEvents: { nodes: [{ createdAt: ago(5) }] } } });
  assert.equal(judge(draft).done, false, 'Without ignoredChecks the Draft skip still waits for a run since Ready');
  assert.equal(judge(draft, { ignoredChecks: ['Backend'] }).done, true);
  assert.equal(judge(draft, { ignoredChecks: ['Lint'] }).done, false, 'A check not listed still waits');
});

test('open Sonar issues are red, an unreadable count is not clean, a failed read throws', () => {
  const withSonar = answer => facts({ contexts: [job(1), sonarCheck], sonar: new Map([[sonarCheck, answer]]) });
  assert.equal(judge(withSonar({ total: 0, lines: [] })).failed, false);
  const open = judge(withSonar({ total: 2, lines: ['sonar: rule A.java:1 m'] }));
  assert.deepEqual([open.failed, open.reasons], [true, ['2 open Sonar issues']]);
  assert.match(judge(withSonar({ total: null, lines: [] })).lines.join('\n'), /^blocker: the Sonar issue count is unreadable/m);
  assert.throws(() => judge(withSonar({ error: new Error('Sonar API answered 401') })), /401/);
});

test('a cancelled Sonar analysis counts as done with 0 findings and stays red otherwise', () => {
  const cancelled = { ...sonarCheck, conclusion: 'CANCELLED' };
  const withCancelled = answer => judge(facts({ contexts: [job(1), cancelled], sonar: new Map([[cancelled, answer]]) }));
  assert.equal(withCancelled({ total: 0, lines: [] }).failed, false);
  assert.equal(withCancelled({ total: 1, lines: ['sonar: r A.java:1 m'] }).failed, true);
  assert.equal(withCancelled({ total: null, lines: [] }).failed, true);
  assert.equal(judge(facts({ contexts: [job(1), job(2, 'CANCELLED')] })).failed, true);
});

test('a change request is dismissed only on handoff, once all threads are resolved', () => {
  const requested = { author: { login: 'coderabbitai' }, state: 'CHANGES_REQUESTED' };
  const stale = threads => facts({ threads, pr: { latestOpinionatedReviews: { totalCount: 1, nodes: [requested] } },
    reviewList: [{ id: 9, user: { login: 'coderabbitai[bot]' }, state: 'CHANGES_REQUESTED', commit_id: 'old' }] });
  const settings = { optionalReviewers: ['coderabbitai'] };
  assert.equal(judge(stale([]), settings).dismissals.length, 0);
  assert.deepEqual(judge(stale([]), settings, { dismissStale: true }).dismissals.map(({ id }) => id), [9]);
  assert.equal(judge(stale(['t']), settings, { dismissStale: true }).dismissals.length, 0);
});

test('the Sonar door reads only the linked analysis and never reads an unreadable count as clean', t => {
  const token = process.env.SONAR_TOKEN;
  process.env.SONAR_TOKEN = '';
  t.after(() => { if (token === undefined) delete process.env.SONAR_TOKEN; else process.env.SONAR_TOKEN = token; });
  assert.throws(() => sonarIssues('http://127.0.0.1/d?id=k&pullRequest=7', 7), /does not link PR #7/);
  assert.throws(() => sonarIssues('https://sonarcloud.io/d?id=k&pullRequest=8', 7), SonarOtherPr);
  assert.deepEqual(sonarIssues('https://sonarcloud.io/d?id=k&pullRequest=7', 7, '[0 New issues]'), { total: 0, lines: [] });
  assert.equal(sonarIssues('https://sonarcloud.io/d?id=k&pullRequest=7', 7, 'passed').total, null);
});

test('an open thread line names the number that `board.mjs threads` takes', () => {
  const lines = judge(facts({ threads: ['https://github.com/test/example/pull/7#discussion_r555', 'thread-0'] })).lines;
  assert.ok(lines.includes('thread https://github.com/test/example/pull/7#discussion_r555 (board.mjs threads 7 --resolve 555)'));
  assert.ok(lines.includes('thread thread-0'), 'A link without a number stays as it was');
});
