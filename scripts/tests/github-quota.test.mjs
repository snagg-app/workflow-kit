import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub, useGhAdapter } from '../github.mjs';

const RESET = Math.floor(Date.now() / 1000) + 1800;
const resetAt = new Date(RESET * 1000).toISOString();
const reply = (body, remaining) => `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: ${RESET}\r\n\r\n${JSON.stringify(body)}`;
const github = () => createGithub({ tool: {}, projectDirectory: '.', sleep() {}, say() {}, reserve: 50 });

test('a mutation answer with a header quota never raises the quota a read reported in the same window', t => {
  t.after(() => useGhAdapter(undefined));
  const answers = [reply({ data: { rateLimit: { cost: 1, remaining: 600, resetAt } } }, 600), reply({ data: { x: 1 } }, 5000)];
  useGhAdapter(() => answers.shift());
  const gh = github();
  gh.graphql('query { a }');
  gh.graphql('mutation { b }');
  assert.equal(gh.quota.remaining, 600, 'The headers (up to 4400 too high) do not overrule the exact body value');
});

test('a header quota is used when no exact value is known, and when a new window began', t => {
  t.after(() => useGhAdapter(undefined));
  const gh = github();
  useGhAdapter(() => reply({ data: { x: 1 } }, 4000));
  gh.graphql('mutation { b }');
  assert.equal(gh.quota.remaining, 4000);
  gh.quota = { remaining: 10, resetAt: new Date((RESET - 3600) * 1000).toISOString() };
  gh.graphql('mutation { b }');
  assert.equal(gh.quota.remaining, 4000, 'An older window is replaced');
});

test('text echoed in the content does not count as a quota error', t => {
  t.after(() => useGhAdapter(undefined));
  let calls = 0;
  useGhAdapter(() => {
    calls++;
    throw Object.assign(new Error('failed'), {
      stderr: 'gh: Could not resolve to an Issue (HTTP 200)',
      stdout: reply({ data: { addComment: { body: 'We hit an API rate limit yesterday' } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }, 4000),
    });
  });
  assert.throws(() => github().graphql('mutation { b }'), /failed/, 'The original error, not a quota message');
  assert.equal(calls, 1, 'The request is not repeated');
});

test('a quota error in errors[] still counts', t => {
  t.after(() => useGhAdapter(undefined));
  let calls = 0;
  useGhAdapter(() => {
    calls++;
    return reply({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 0);
  });
  assert.throws(() => github().graphql('query { a }'), /quota is used up|rate limit/i);
  assert.ok(calls > 1, 'It is retried or waited out');
});
