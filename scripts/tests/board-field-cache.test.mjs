import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('next ranks by the Priority order of the Project, not by a cached one', t => {
  const { checkout, env, run } = fixture(t);
  env.BOARD_FIELD_CACHE = '';
  // The cache holds the options as [Low, High]; the Project (fake) lists [High, Low].
  writeFileSync(join(checkout, '.git', 'board-project-fields.json'), JSON.stringify({ project: 'P1',
    fields: [{ id: 'F2', name: 'Priority', options: ['Low', 'High'].map(name => ({ id: name, name })) }] }));
  const row = (number, priority) => ({ ...issue(), number, issueFieldValues: { nodes: [] },
    projectItems: { nodes: [{ id: 'PI' + number, project: { id: 'P1' }, status: { name: 'Ready' }, priority: { name: priority } }] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1, 'Low'), row(2, 'High')]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.indexOf('#2 [High]') >= 0 && result.stdout.indexOf('#2 [High]') < result.stdout.indexOf('#1 [Low]'), result.stdout);
});

test('stale ids in the cache are read again at the write, for every field of one call', t => {
  const { checkout, env, queries, run, writeIssue } = fixture(t);
  env.BOARD_FIELD_CACHE = '';
  // Both options carry an id GitHub no longer knows.
  writeFileSync(join(checkout, '.git', 'board-project-fields.json'), JSON.stringify({ project: 'P1', fields: [
    { id: 'F2', name: 'Priority', options: [{ id: 'old-High', name: 'High' }] },
    { id: 'F3', name: 'Size', options: [{ id: 'old-XS', name: 'XS' }] }] }));
  writeIssue(issue());
  const result = run('field', '1', 'Size', 'XS', 'Priority', 'High');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(checkout, 'stored-values.json'), 'utf8')), { F3: 'XS', F2: 'High' }, 'both fields are written with the fresh ids');
  assert.equal(queries().filter(query => query.includes('fields(first:100)')).length, 1, 'the definitions are read again once, not per field');
});
