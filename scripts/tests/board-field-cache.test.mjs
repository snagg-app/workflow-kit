import assert from 'node:assert/strict';
import { fixture, issue, test } from './board-fixture.mjs';

test('the field definitions are read once and then served from the Git directory until a name or option is missing', t => {
  const { env, queries, run, writeIssue } = fixture(t);
  env.BOARD_FIELD_CACHE = ''; // the other board tests switch the cache off, and so may the caller's environment
  const definitions = () => queries().filter(query => query.includes('fields(first:100)')).length;
  writeIssue(issue());
  assert.equal(run('field', '1', 'Size', 'xs').status, 0);
  assert.equal(definitions(), 1);
  assert.equal(run('field', '1', 'Size', 'S').status, 0);
  assert.equal(definitions(), 0, 'the second call reads no definitions');
  assert.match(run('field', '1', 'Size', 'XXL').stdout, /^ERROR - /, 'an option missing from the cache is looked up again, then refused');
  assert.equal(definitions(), 1);
});
