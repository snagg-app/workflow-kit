import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';

test('new permits initial Backlog for a spec but refuses any other initial status before creation', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), typeof data === 'string' ? data : JSON.stringify(data));
  write('body.md', 'Spec scope');
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'spec' }]);
  write('create-response.json', { number: 1, node_id: 'N1', html_url: 'https://github.com/test/example/issues/1' });
  write('backlink-1.json', { number: 1, milestone: { title: '0.1.1' }, labels: [{ name: 'spec' }] });
  writeIssue(issue('Backlog'));
  const args = ['new', '--title', 'Spec', '--body-file', 'body.md', '--milestone', '0.1.1', '--label', 'Spec', '--priority', 'low'];
  for (const status of ['Ready', 'In progress', 'Automated review', 'Human review', 'Done']) {
    const result = run(...args, '--status', status);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /new spec starts in Backlog/);
    assert.equal(existsSync(join(checkout, 'created.json')), false);
    assert.equal(existsSync(join(checkout, 'mutations')), false);
  }
  assert.equal(run(...args).status, 0, 'creating a spec in Backlog stays supported');
});

test('new applies the Status guard of field before creating: Ready with an open decision wait is refused (#944)', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), typeof data === 'string' ? data : JSON.stringify(data));
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }]);
  write('create-response.json', { number: 1, node_id: 'N1', html_url: 'https://github.com/test/example/issues/1' });
  write('backlink-1.json', { number: 1, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }] });
  writeIssue(issue('Backlog'));
  const args = ['new', '--title', 'Titel', '--body-file', 'body.md', '--milestone', '0.1.1', '--label', 'enhancement', '--priority', 'low', '--status', 'Ready'];
  write('body.md', 'Text\n\nWartet bis: Entscheidung Milan');
  const refused = run(...args);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /cannot be Ready.*decision/i);
  assert.equal(existsSync(join(checkout, 'created.json')), false, 'nothing is created');
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'nothing is written');
  write('body.md', 'Text');
  assert.equal(run(...args).status, 0, 'without the wait, Ready is created');
});


test('new checks every required value before creating, reads all values back and starts the issue on request', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), typeof data === 'string' ? data : JSON.stringify(data));
  const read = file => JSON.parse(readFileSync(join(checkout, file), 'utf8'));
  const created = join(checkout, 'created.json'), mutations = join(checkout, 'mutations');
  const stored = changes => write('backlink-1.json', { number: 1, state: 'open', comments: 0, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }], assignees: [], ...changes });
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }, { name: 'ci' }]);
  write('create-response.json', { number: 1, node_id: 'N1', html_url: 'https://github.com/test/example/issues/1' });
  write('backlink-comments-1.json', []);
  write('body.md', '﻿Text\r\n'); // a BOM from PowerShell 5 is not part of the text
  write('bom-only.md', '﻿');
  stored();
  writeIssue(issue('Backlog'));
  const base = ['new', '--title', 'Titel', '--body-file', 'body.md', '--milestone', '0.1.1', '--label', 'Enhancement', '--priority', 'low', '--field', 'Size=xs'];

  // A missing or invalid value stops the command before anything exists.
  const refused = (reason, ...args) => {
    const result = run(...args);
    assert.equal(result.status, 2, `${reason}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^ERROR - [^\n]*\n$/, reason);
    assert.equal(result.stderr, '', 'No stack trace');
    assert.equal(existsSync(created), false, `${reason}: the issue must not be created`);
    assert.equal(existsSync(mutations), false, reason);
    return result.stdout;
  };
  refused('no priority', ...base.filter((arg, index) => ![8, 9].includes(index)));
  refused('no label', ...base.filter((arg, index) => ![6, 7].includes(index)));
  refused('unknown label', ...base, '--label', 'nope');
  refused('unknown milestone', ...base.map(arg => arg === '0.1.1' ? '9.9' : arg));
  assert.match(refused('unknown option', ...base.map(arg => arg === 'Size=xs' ? 'Size=XXL' : arg)), /XS.*S/);
  refused('Status is no --field', ...base, '--field', 'Status=Done');
  assert.match(refused('a file with only a BOM is empty', ...base.map(arg => arg === 'body.md' ? 'bom-only.md' : arg)), /empty/);
  refused('a Status the Project does not have', ...base, '--status', 'Nonsense');
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1', requiredFields: ['Zielrelease'] }));
  assert.match(refused('a field the project requires', ...base), /Zielrelease/);
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1', requiredFields: ['Size'] }));

  // An unreadable answer to the creation does not prove that nothing exists: the error says so.
  write('create-response.json', 'not json');
  let result = run(...base);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - .*may exist anyway.*before trying again/);
  rmSync(created);
  write('create-response.json', { number: 1, node_id: 'N1', html_url: 'https://github.com/test/example/issues/1' });

  // The issue lands in Backlog; a label given twice (other casing) is one label.
  result = run(...base, '--label', 'ENHANCEMENT');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // One line with the URL and the values read back; their order and separators are not pinned.
  assert.match(result.stdout, /^NEW https:\/\/github\.com\/test\/example\/issues\/1\b[^\n]*\n$/);
  for (const value of ['0.1.1', 'enhancement', 'Backlog', 'Low', 'XS']) assert.ok(result.stdout.includes(value), value);
  assert.deepEqual(read('created.json'), { title: 'Titel', body: 'Text', milestone: 4, labels: ['enhancement'] });
  assert.deepEqual(read('stored-values.json'), { F1: 'Backlog', F2: 'Low', F3: 'XS' });
  assert.equal(existsSync(join(checkout, 'comment-writes')), false, 'No claim comment');

  // --status sets the Project status at creation (#418).
  result = run(...base, '--status', 'Ready');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(read('stored-values.json'), { F1: 'Ready', F2: 'Low', F3: 'XS' });
  assert.equal(existsSync(join(checkout, 'comment-writes')), false, 'No claim with --status');

  // A value that does not read back is a failure that names the created issue.
  stored({ milestone: { title: 'other' } });
  result = run(...base);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - .*issues\/1 was created, but reading it back failed/);
  stored();

  // A failing write after the issue exists says so instead of failing as if nothing happened.
  writeFileSync(join(checkout, 'mutation-fails'), '');
  result = run(...base);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - .*issues\/1 was created, but setting the Project fields failed.*do not create it again/);
});

test('new --from checks every entry before creating, then costs few GraphQL requests however many issues it creates', t => {
  const { checkout, run, queries } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), typeof data === 'string' ? data : JSON.stringify(data));
  const read = file => JSON.parse(readFileSync(join(checkout, file), 'utf8'));
  const gone = file => !existsSync(join(checkout, file));
  const answers = count => Array.from({ length: count }, (_, index) => ({ number: index + 1, node_id: `N${index + 1}`, html_url: `https://github.com/test/example/issues/${index + 1}` }));
  const entry = (title, size, changes) => ({ title, bodyFile: 'body.md', milestone: '0.1.1', labels: ['enhancement'], priority: 'Low', fields: { Size: size }, ...changes });
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }]);
  write('body.md', 'Text\n');
  for (const number of [1, 2, 3]) write(`backlink-${number}.json`, { number, state: 'open', comments: 0, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }], assignees: [] });
  const create = (list, count = list.length) => {
    for (const file of ['creates', 'stored-items.json', 'stored-values.json', 'mutations']) rmSync(join(checkout, file), { force: true });
    write('create-responses.json', answers(count));
    write('list.json', list);
    queries();
    return run('new', '--from', 'list.json');
  };

  // One bad entry anywhere creates nothing and says which one it is.
  for (const [reason, bad, expected] of [['an unknown option', entry('C', 'XXL'), /entry 3 "C".*XS.*S/], ['an unknown key', entry('C', 'S', { label: 'x' }), /entry 3 "C".*unknown key label/],
    ['a missing priority', entry('C', 'S', { priority: undefined }), /entry 3 "C".*priority is required/], ['an unknown label', entry('C', 'S', { labels: ['nope'] }), /entry 3 "C".*no label "nope"/]]) {
    const result = create([entry('A', 'XS'), entry('B', 'S'), bad]);
    assert.equal(result.status, 2, `${reason}: ${result.stdout}`);
    assert.match(result.stdout, expected, reason);
    assert.ok(gone('creates') && gone('mutations'), `${reason}: nothing may be created or written`);
  }
  assert.match(create({ not: 'a list' }).stdout, /JSON list/);

  // Three issues: created over REST, then four GraphQL requests in all (field definitions, add to Project, write values, read back).
  let result = create([entry('A', 'XS'), entry('B', 'S'), entry('C', 'XS')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => line.split(' | ')[0]), [1, 2, 3].map(number => `NEW https://github.com/test/example/issues/${number}`));
  for (const value of ['0.1.1', 'enhancement', 'Backlog', 'Low']) assert.ok(result.stdout.split('\n').every(line => !line || line.includes(value)), value);
  assert.deepEqual(readFileSync(join(checkout, 'creates'), 'utf8').trim().split('\n').map(line => JSON.parse(line).title), ['A', 'B', 'C']);
  assert.deepEqual(read('stored-items.json'), Object.fromEntries([['XS'], ['S'], ['XS']].map(([size], index) => [`PI-N${index + 1}`, { F1: 'Backlog', F2: 'Low', F3: size }])));
  assert.equal(queries().length, 4, 'The number of requests does not grow with the number of issues');

  // The Project may have added the issues first; that is no failure as long as the items are readable.
  write('add-exists', '');
  result = create([entry('A', 'XS'), entry('B', 'S')]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(queries().length, 5, 'One more request finds the items the Project added');
  write('add-exists-unreadable', '');
  result = create([entry('A', 'XS')]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - 1 of 1 issues exist: https:\/\/github\.com\/test\/example\/issues\/1, but setting the Project fields failed.*do not create them again/);
  rmSync(join(checkout, 'add-exists'));
  rmSync(join(checkout, 'add-exists-unreadable'));

  // A value that does not read back, and a creation that fails half-way, name every issue that exists.
  write('lost', 'Done');
  result = create([entry('A', 'XS'), entry('B', 'S')]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - 2 of 2 issues exist: \S*issues\/1 \S*issues\/2, but setting the Project fields failed.*Read-back of/);
  rmSync(join(checkout, 'lost'));
  result = create([entry('A', 'XS'), entry('B', 'S'), entry('C', 'XS')], 2);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - creating the issue failed.*2 of 3 issues exist: \S*issues\/1 \S*issues\/2.*never an existing one again/);
  assert.ok(gone('mutations'), 'Nothing is written to the Project after a failed creation');
});

test('new --from halves a request GitHub refuses for its cost, and lists an issue it cannot finish with the command that does', t => {
  const { checkout, run, queries } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), typeof data === 'string' ? data : JSON.stringify(data));
  const count = 13;
  const answers = () => write('create-responses.json', Array.from({ length: count }, (_, index) => ({ number: index + 1, node_id: `N${index + 1}`, html_url: `https://github.com/test/example/issues/${index + 1}` })));
  const entry = number => ({ title: `T${number}`, bodyFile: 'body.md', milestone: '0.1.1', labels: ['enhancement'], priority: 'Low', fields: { Size: number % 2 ? 'XS' : 'S' } });
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }]);
  write('body.md', 'Text\n');
  answers();
  for (let number = 1; number <= count; number++) write(`backlink-${number}.json`, { number, state: 'open', comments: 0, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }], assignees: [] });
  write('list.json', Array.from({ length: count }, (_, index) => entry(index + 1)));
  write('resource-limit', '3');
  queries();

  // GitHub refuses every request that names more than 3 issues: all 13 still arrive complete.
  let result = run('new', '--from', 'list.json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, count);
  const stored = JSON.parse(readFileSync(join(checkout, 'stored-items.json'), 'utf8'));
  assert.deepEqual(stored, Object.fromEntries(Array.from({ length: count }, (_, index) => [`PI-N${index + 1}`, { F1: 'Backlog', F2: 'Low', F3: (index + 1) % 2 ? 'XS' : 'S' }])));
  for (const line of readFileSync(join(checkout, 'mutations'), 'utf8').trim().split('\n')) {
    assert.ok(new Set(line.match(/(?:contentId|itemId|issueId):"[^"]*"/g)?.map(id => id.replace('PI-', ''))).size <= 3, 'GitHub accepted a request of more than 3 issues');
  }
  assert.ok(queries().length > 4, 'The refused blocks were asked again in halves');

  // One issue GitHub never accepts: the others are complete, and it is listed with the command that finishes it.
  for (const file of ['creates', 'stored-items.json', 'stored-values.json', 'mutations']) rmSync(join(checkout, file), { force: true });
  write('resource-stuck', 'N7');
  answers();
  result = run('new', '--from', 'list.json');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^ERROR - 13 of 13 issues exist: .*but setting the Project fields failed: .*#7.*board\.mjs field 7 Status Backlog Priority Low Size XS;/);
  assert.equal(result.stdout.match(/board\.mjs field \d/g).length, 1, 'Only the stuck issue is listed');
  const items = JSON.parse(readFileSync(join(checkout, 'stored-items.json'), 'utf8'));
  assert.equal(Object.keys(items).length, count - 1, 'Every other issue was written');
  assert.equal(items['PI-N7'], undefined);
});

test('new refuses an unknown flag before creating anything', t => {
  fixture(t).refusesUnknownFlag('new', '--title', 'T');
});

test('new refuses a title an open issue already has, so parallel sessions create no duplicate (#618)', t => {
  const { checkout, run } = fixture(t);
  const write = (file, data) => writeFileSync(join(checkout, file), JSON.stringify(data));
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }]);
  write('test-issues.json', [{ number: 5, title: ' Gleicher Titel', html_url: 'https://github.com/test/example/issues/5' },
    { number: 6, title: 'PR-Titel', html_url: 'h', pull_request: {} }]);
  write('create-response.json', { number: 1, node_id: 'N1', html_url: 'https://github.com/test/example/issues/1' });
  write('backlink-1.json', { number: 1, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }] });
  writeFileSync(join(checkout, 'body.md'), 'Text');
  const created = join(checkout, 'created.json');
  const single = title => run('new', '--title', title, '--body-file', 'body.md', '--milestone', '0.1.1', '--label', 'enhancement', '--priority', 'low');
  const refused = (result, pattern) => {
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, pattern);
    assert.equal(existsSync(created), false, 'nothing is created');
  };
  refused(single('gleicher titel '), /^ERROR - .*issues\/5/);
  const entry = title => ({ title, bodyFile: 'body.md', milestone: '0.1.1', labels: ['enhancement'], priority: 'Low' });
  write('list.json', [entry('Neu'), entry('Gleicher Titel')]);
  refused(run('new', '--from', 'list.json'), /^ERROR - .*issues\/5/);
  write('list.json', [entry('Zweimal'), entry('zweimal')]);
  refused(run('new', '--from', 'list.json'), /^ERROR - .*Zweimal/i);
  // A pull request with the same title is no issue.
  assert.equal(single('PR-Titel').status, 0);
});
