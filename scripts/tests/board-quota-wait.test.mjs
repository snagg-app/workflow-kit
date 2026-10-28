import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, test } from './board-fixture.mjs';

// quota-wait returns once the GraphQL quota has points again (the fake gh reports resets one to three seconds away).

test('quota-wait returns at once while the quota is free and sleeps through a refusal until its reset', t => {
  const { checkout, run, env } = fixture(t);
  env.BOARD_SLEEP_SCALE = '1'; // these sleep until a reset on the real clock
  writeFileSync(join(checkout, 'quota-left'), '4000');
  let started = Date.now();
  let result = run('quota-wait');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started < 2500, 'Nothing to wait for');

  writeFileSync(join(checkout, 'limited'), '');
  started = Date.now();
  result = run('quota-wait');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started >= 1000, 'The refusal was waited out until its reset, a second away');
  assert.equal(existsSync(join(checkout, 'limited')), false, 'and the query was asked again');
});

test('quota-wait reports the rateLimit of the answer body, not stale headers (#625)', t => {
  const { checkout, run, env } = fixture(t);
  env.BOARD_SLEEP_SCALE = '1'; // these sleep until a reset on the real clock
  writeFileSync(join(checkout, 'quota-left'), '4979'); // headers claim plenty
  writeFileSync(join(checkout, 'quota-body'), '10'); // the real query says almost nothing is left
  const result = run('quota-wait', '--max-minutes', '0.1');
  assert.equal(result.status, 4, result.stdout + result.stderr);
});

test('quota-wait does not report DONE for a successful HTTP response with GraphQL errors', t => {
  const { checkout, run, env } = fixture(t);
  env.BOARD_SLEEP_SCALE = '1'; // these sleep until a reset on the real clock
  writeFileSync(join(checkout, 'limited-200'), '');
  const started = Date.now();
  const result = run('quota-wait');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Date.now() - started >= 1000, 'It waited for a successful Viewer response');
});

test('quota-wait ends "still waiting" with the reset time when it would outlast --max-minutes, also below the points wait needs', t => {
  const { checkout, run, env } = fixture(t);
  env.BOARD_SLEEP_SCALE = '1'; // these sleep until a reset on the real clock
  writeFileSync(join(checkout, 'limited'), '');
  const refused = run('quota-wait', '--max-minutes', '0.001');
  assert.equal(refused.status, 4, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /^still waiting: call quota-wait again after \d{4}-\d\d-\d\dT[\d:.]+Z \(GitHub quota pause\)$/m);

  // 10 points are left and the reset is 3 seconds away, again after each answer: the first pause fits, the second does not.
  writeFileSync(join(checkout, 'quota-left'), '10');
  const started = Date.now();
  const low = run('quota-wait', '--max-minutes', '0.1');
  assert.equal(low.status, 4, low.stdout + low.stderr);
  assert.ok(Date.now() - started >= 3000, 'It slept until the reset once');
  assert.equal(run('quota-wait', '--max-minutes', 'x').status, 2, 'A bad limit is refused');
});
