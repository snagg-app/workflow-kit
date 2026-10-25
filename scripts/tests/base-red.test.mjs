import assert from 'node:assert/strict';
import test from 'node:test';
import { baseRedLines, baseRedTests, testClass } from '../base-red.mjs';

test('baseRedTests reads the remembered names once; testClass is the segment before the method', () => {
  assert.deepEqual(baseRedTests('head\nok step\nbase-red: io.A.one\nbase-red: io.A.one\nbase-red: io.B.two'), ['io.A.one', 'io.B.two']);
  assert.equal(testClass('io.snagg.StashServiceTest.addsItem'), 'StashServiceTest');
  assert.equal(testClass('Alone'), 'Alone');
});

test('baseRedLines names the open issue of a class and creates one only for a class without', () => {
  const made = [];
  const lines = baseRedLines(['io.A.one', 'io.A.two', 'io.B.three'], [{ title: 'x', body: 'A is red', html_url: 'u/1' }, { title: 'B is red', html_url: 'u/2' }],
    (className, tests) => { made.push([className, tests]); return 'u/new'; });
  assert.deepEqual(lines, ['- `io.A.one`, `io.A.two`: Issue u/1', '- `io.B.three`: Issue u/2']);
  assert.deepEqual(made, []);
  assert.deepEqual(baseRedLines(['io.C.x'], [], (className, tests) => { made.push([className, tests]); return 'u/new'; }), ['- `io.C.x`: neues Issue u/new']);
  assert.deepEqual(made, [['C', ['io.C.x']]]);
});
