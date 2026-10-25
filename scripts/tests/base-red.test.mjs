import assert from 'node:assert/strict';
import test from 'node:test';
import { baseRedLines, baseRedTests, testClass, withBaseRed } from '../base-red.mjs';

const t = { baseRedKnown: url => `known ${url}`, baseRedNew: url => `new ${url}`, baseRedFailed: why => `failed ${why}` };

test('baseRedTests reads the remembered names once; testClass is the segment before the method', () => {
  assert.deepEqual(baseRedTests('head\nok step\nbase-red: io.A.one\nbase-red: io.A.one\nbase-red: io.B.two'), ['io.A.one', 'io.B.two']);
  assert.equal(testClass('io.snagg.StashServiceTest.addsItem'), 'StashServiceTest');
  assert.equal(testClass('Alone'), 'Alone');
});

test('baseRedLines names the open issue that mentions the class as a word and creates one only otherwise; a failed creation is a line', () => {
  const made = [];
  const create = (className, tests) => { made.push([className, tests]); return 'u/new'; };
  const open = [{ title: 'x', body: 'Aa is red', html_url: 'u/1' }, { title: 'B is red', html_url: 'u/2' }, { title: 'StashServiceTestHelper', html_url: 'u/3' }];
  assert.deepEqual(baseRedLines(['io.B.three'], open, create, t), ['- `io.B.three`: known u/2']);
  assert.deepEqual(baseRedLines(['io.A.one', 'io.A.two'], open, create, t), ['- `io.A.one`, `io.A.two`: new u/new'], '"Aa" is not the word A');
  assert.deepEqual(baseRedLines(['io.StashServiceTest.x'], open, create, t), ['- `io.StashServiceTest.x`: new u/new'], 'a longer class name is another class');
  assert.deepEqual(made.map(([className]) => className), ['A', 'StashServiceTest']);
  assert.deepEqual(baseRedLines(['io.C.x'], [], () => { throw new Error('no milestone\nmore'); }, t), ['- `io.C.x`: failed no milestone']);
});

test('withBaseRed puts the section before the Retro list', () => {
  assert.equal(withBaseRed('Done.\n\n### Retro\n\n- none', 'S'), 'Done.\n\nS\n\n### Retro\n\n- none');
  assert.equal(withBaseRed('Done.', 'S'), 'Done.\n\nS');
});
