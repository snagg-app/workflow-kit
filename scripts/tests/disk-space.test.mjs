import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lowDiskRefusal } from '../disk-space.mjs';

const gb = n => () => ({ bavail: n * 1024, bsize: 2 ** 20 });

test('under 5 GB free refuses with the numbers, enough or unreadable passes', () => {
  assert.match(lowDiskRefusal('/x', 5, gb(4.2)), /only 4\.2 GB free/);
  assert.equal(lowDiskRefusal('/x', 5, gb(5)), null);
  assert.equal(lowDiskRefusal('/x', 5, () => { throw new Error('no statfs'); }), null);
});
