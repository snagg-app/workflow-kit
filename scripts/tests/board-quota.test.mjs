import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quotaOf, retryAt, splitResponse, untilText, waitInterval } from '../quota.mjs';
import { fixture, handoffPr, issue, test } from './board-fixture.mjs';

test('check reports its own GraphQL calls and spend, including a refused read', t => {
  const { checkout, run, writeIssue, queries } = fixture(t);
  writeIssue(issue());
  writeFileSync(join(checkout, 'quota-left'), '4000');
  const result = run('check', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const count = queries().length;
  assert.match(result.stderr, new RegExp(`quota: 4000 left, ${count} points used by this run, ${count} GraphQL calls, resets `));
  writeFileSync(join(checkout, 'limited'), '');
  const refused = run('check', '1');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /quota: 0 left, 0 points used by this run, 1 GraphQL calls, resets /, 'A failure carries its own actual quota; no invented charge');
});

test('a used-up GraphQL quota is waited out by reviews and reported by the other commands', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  writeIssue(issue());
  writeFileSync(join(checkout, 'limited'), '');
  const started = Date.now();
  const waited = run('reviews', '7');
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  assert.ok(Date.now() - started >= 1000, 'The command slept until the reset (a second away) before asking again');
  assert.equal(existsSync(join(checkout, 'limited')), false, 'The refused query was asked again');
  writeFileSync(join(checkout, 'limited'), '');
  const stopped = run('check', '1');
  assert.equal(stopped.status, 2, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /\d{4}-\d\d-\d\dT[^(]*\(in \d+ min\)/, 'Commands that cannot wait name the time to try again, and the minutes until then');
});

test('a reset time in the future does not make wait or reviews sleep while the headers show free quota', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  // The headers report 4000 points left and a reset three seconds away: nothing to wait for.
  writeFileSync(join(checkout, 'quota-left'), '4000');
  let started = Date.now();
  let result = run('reviews', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started < 2500, 'Free quota is no reason to wait for the reset');
  // A refusal whose own headers show free quota is stale: the command asks again at once, silently.
  writeFileSync(join(checkout, 'limited'), 'free');
  started = Date.now();
  result = run('reviews', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started < 2500, 'A stale refusal is not waited out');
  assert.ok(!result.stderr.includes('rate limited until'), 'It says nothing about a reset it does not wait for');
});

test('the quota is read from the headers of a response, a refusal included', () => {
  const response = 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-Ratelimit-Remaining: 42\r\nX-Ratelimit-Reset: 1791346834\r\n\r\n{"data":{}}';
  const { headers, body } = splitResponse(response);
  assert.equal(body, '{"data":{}}');
  assert.deepEqual(quotaOf(headers), { remaining: 42, resetAt: '2026-10-07T04:20:34.000Z' });
  assert.equal(quotaOf(splitResponse('{"data":{}}').headers), undefined, 'Without headers there is no quota to report');
  assert.equal(untilText('2026-10-07T04:20:34.000Z', Date.parse('2026-10-07T04:14:10Z')), '2026-10-07T04:20:34.000Z (in 7 min)');
});

test('little quota left does not require another GraphQL query for the review threads', t => {
  const { checkout, run, queries } = fixture(t);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  writeFileSync(join(checkout, 'quota-left'), '10');
  const result = run('reviews', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sent = queries();
  assert.equal(sent.length, 1, 'One query carries the PR and its review threads');
  assert.ok(sent[0].includes('readyEvents') && sent[0].includes('reviewThreads'), 'The one query includes both required reads');
});

test('wait pauses longer with every quiet read and, below 1000 points left, twice as long', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(reads => waitInterval(reads, 5000)), [60, 90, 135, 202.5, 300, 300, 300]);
  for (const reads of [0, 3, 9]) assert.ok(waitInterval(reads, 999) > waitInterval(reads, 1000), 'Little quota left lengthens the pause');
  assert.equal(waitInterval(0, undefined), 60, 'An unknown quota changes nothing');
});

test('a secondary limit is retried within minutes, only the primary one waits for the hourly reset', () => {
  const now = Date.parse('2026-10-07T00:00:00Z'), hourly = () => '2026-10-07T00:55:00.000Z';
  const secondary = 'You have exceeded a secondary rate limit';
  assert.deepEqual([0, 1, 2].map(refusals => retryAt(secondary, refusals, hourly, now)),
    ['2026-10-07T00:01:00.000Z', '2026-10-07T00:02:00.000Z', '2026-10-07T00:04:00.000Z']);
  assert.equal(retryAt('API rate limit already exceeded for user ID 1', 0, hourly, now), hourly());
  assert.equal(retryAt(secondary, 0, hourly, now, { 'retry-after': '600' }), '2026-10-07T00:10:00.000Z', 'A longer Retry-After wins over the backoff');
});
