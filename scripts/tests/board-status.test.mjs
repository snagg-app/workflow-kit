import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, handoffPr, issue, predecessor, test } from './board-fixture.mjs';

test('the review status is selected by its own name, with validation and backlinks; no other spelling is an alias (#816)', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const file = name => join(checkout, name);
  writeIssue(issue('In progress'));
  writeFileSync(file('pr.json'), JSON.stringify(handoffPr({ url: 'https://github.com/test/example/pull/7', body: 'Closes #1' })));
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 1 }));
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, body: 'https://github.com/test/example/pull/7', html_url: 'u' }]));
  writeFileSync(file('status-options.json'), JSON.stringify(['Automated review']));
  const refused = run('field', '1', 'Status', 'Automated review');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /braucht die PR-Nummer/);
  assert.equal(existsSync(file('mutations')), false, 'Backlinks are checked before any write');
  const result = run('field', '1', 'Status', 'automated review', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(file('stored'), 'utf8'), 'Automated review');
  for (const options of [[], ['Auto review'], ['Automatic review']]) {
    writeFileSync(file('status-options.json'), JSON.stringify(options));
    rmSync(file('mutations'), { force: true });
    assert.equal(run('field', '1', 'Status', 'Automated review', '7').status, 2);
    assert.equal(existsSync(file('mutations')), false, 'An unknown or missing option writes nothing');
  }
});

test('Automated review sets the missing native link and backlink itself and refuses only when that fails', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const count = file => existsSync(join(checkout, file)) ? readFileSync(join(checkout, file), 'utf8').split('\n').filter(Boolean).length : 0;
  const writes = pattern => (readFileSync(join(checkout, 'mutations'), 'utf8').match(pattern) ?? []).length;
  const prepare = () => {
    for (const file of ['mutations', 'link-noop', 'comment-writes']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: false, linkPages: [[]],
      url: 'https://github.com/test/example/pull/7', body: 'Refs #1' })));
    writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
    writeFileSync(join(checkout, 'backlink-comments-1.json'), '[]');
  };

  prepare();
  writeFileSync(join(checkout, 'link-noop'), '');
  let result = run('field', '1', 'Status', 'Automated review', '7');
  assert.equal(result.status, 2, 'A link whose read-back lacks the issue still refuses: ' + result.stdout);
  assert.equal(writes(/updateProjectV2ItemFieldValue/g), 0, 'and the status stays unwritten');

  prepare();
  result = run('field', '1', 'Status', 'Automated review', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(writes(/addCloseIssueReferences/g), 1, 'The missing native link is written once');
  assert.equal(count('comment-writes'), 1, 'and so is the missing backlink comment');
  assert.equal(writes(/updateProjectV2ItemFieldValue/g), 1, 'then the status');

  assert.equal(run('field', '1', 'Status', 'Automated review', '7').status, 0);
  assert.equal(writes(/addCloseIssueReferences/g), 1, 'A second run writes no second link');
  assert.equal(count('comment-writes'), 1, 'and no second comment');
});


test('Automated review for a Refs PR beside the closing PR posts only the backlink and never links natively (#398)', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('In progress'), closedByPullRequestsReferences: { totalCount: 1, nodes: [
    { number: 8, state: 'OPEN', repository: { nameWithOwner: 'test/example' } }] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: false, linkPages: [[]],
    url: 'https://github.com/test/example/pull/7', body: 'Refs #1' })));
  writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
  writeFileSync(join(checkout, 'backlink-comments-1.json'), '[]');
  const result = run('field', '1', 'Status', 'Automated review', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const writes = readFileSync(join(checkout, 'mutations'), 'utf8');
  assert.equal(/addCloseIssueReferences/.test(writes), false, 'A partial PR is not linked as a second closing PR');
  assert.equal(readFileSync(join(checkout, 'comment-writes'), 'utf8').split('\n').filter(Boolean).length, 1, 'but its backlink comment is written');
  assert.match(writes, /updateProjectV2ItemFieldValue/);
});


test('In progress requires a startable issue assigned to the authenticated user before any mutation', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const mutations = join(checkout, 'mutations');
  const assigned = changes => ({ ...issue(), assignees: { nodes: [{ login: 'worker' }] }, ...changes });
  const cases = [
    issue(),
    { ...issue(), assignees: { nodes: [{ login: 'someone-else' }] } },
    assigned({ blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } }),
    assigned({ blockedBy: { totalCount: 1, nodes: [predecessor('CLOSED', 'NOT_PLANNED')] } }),
    assigned({ blockedBy: { totalCount: 1, nodes: [] } }),
    assigned({ projectItems: { nodes: [] } }),
    assigned({ projectItems: issue('Backlog').projectItems }),
    assigned({ state: 'CLOSED' }),
  ];
  for (const candidate of cases) {
    writeIssue(candidate);
    const result = run('field', '1', 'Status', 'in progress');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected starts must not mutate or add a Project item');
  }
  // Not assigned: one ERROR line, not the check's verdict block in front of it.
  writeIssue(issue());
  assert.match(run('field', '1', 'Status', 'In progress').stdout, /^ERROR - [^\n]*\n$/);
  writeIssue(assigned());
  for (const failure of ['fail', 'fail-viewer']) {
    writeFileSync(join(checkout, failure), '');
    const result = run('field', '1', 'Status', 'In progress');
    assert.notEqual(result.status, 0);
    if (failure === 'fail-viewer') assert.match(result.stdout, /^ERROR - /);
    assert.equal(existsSync(mutations), false, 'API failure must not mutate status');
    rmSync(join(checkout, failure));
  }
  for (const status of ['Ready', 'In progress', 'Automated review', 'Human review']) {
    writeIssue(assigned({ projectItems: issue(status).projectItems }));
    const result = run('field', '1', 'Status', 'In progress');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 4);
  writeIssue(issue());
  assert.equal(run('field', '1', 'Status', 'Ready').status, 0, 'Returning blocked work to Ready does not require assignment');
});

test('Status Ready is refused while a decision wait stands, and names it (#514)', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue(), body: 'Wartet bis: Entscheidung Milan' });
  for (const args of [['field', '1', 'Status', 'Ready'], ['field', '1', 'Status', 'Ready']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /decision of Milan/);
  }
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'A refused transition does not mutate');
  writeIssue(issue());
  assert.equal(run('field', '1', 'Status', 'Ready').status, 0, 'Without the line Ready works');
});

test('An open issue a human reopened leaves Done for In progress with a note; a closed one stays blocked (#510)', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const mutations = join(checkout, 'mutations');
  const done = changes => ({ ...issue('Done'), assignees: { nodes: [{ login: 'worker' }] }, ...changes });
  writeIssue(done({ state: 'CLOSED' }));
  assert.notEqual(run('field', '1', 'Status', 'In progress').status, 0, 'a closed issue in Done stays blocked');
  assert.equal(existsSync(mutations), false);
  writeIssue(done());
  const result = run('field', '1', 'Status', 'In progress');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^note: #1 is open again and was Done; it moves to In progress$/m);
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 1);
  writeIssue(done({ assignees: { nodes: [] } }));
  const refused = run('field', '1', 'Status', 'In progress');
  assert.notEqual(refused.status, 0, 'the assignment is still required');
  assert.doesNotMatch(refused.stdout, /note:/, 'no note for a move that did not happen');
});

test('Automated review requires the declared open PR and every issue backlink before mutating status', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue(issue('In progress'));
  const mutations = join(checkout, 'mutations');
  const pr = { number: 7, state: 'OPEN', isDraft: false, url: 'https://github.com/test/example/pull/7', body: 'Refs #1. Related: #99.', baseRefName: 'release/0.1.0' };
  const writePR = changes => writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...pr, ...changes }));
  let commentId = 0;
  const comment = body => ({ id: ++commentId, body, html_url: `https://github.com/test/example/issues/1#issuecomment-${commentId}` });
  const writeBacklink = (number, comments, changes = {}) => {
    writeFileSync(join(checkout, `backlink-${number}.json`), JSON.stringify({ number, state: 'open', comments: comments.length, ...changes }));
    writeFileSync(join(checkout, `backlink-comments-${number}.json`), JSON.stringify(comments));
  };
  const reject = (...args) => {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected backlink checks must not mutate or add a Project item');
    return result;
  };
  writePR();
  writeBacklink(1, []);
  assert.match(reject('field', '1', 'Status', 'Automated review').stdout, /braucht die PR-Nummer: field ISSUE Status "Automated review" PR/);
  reject('field', '1', 'Status', 'Automated review');
  reject('field', '1', 'Status', 'Automated review', '--oops');
  reject('field', '1', 'Status', 'Automated review', '0');
  reject('field', '1', 'Status', 'Automated review', '7', '--oops');
  reject('field', '1', 'Status', 'Automated review', '7');
  for (const body of [
    'PR #7',
    'https://github.com/other/example/pull/7',
    'https://github.com/test/example/pull/70',
    'https://github.com/test/example/pull/7/files',
    'https://github.com/test/example/pull/6',
    'https://github.com.example.com/test/example/pull/7',
  ]) {
    writeBacklink(1, [comment(body)]);
    reject('field', '1', 'Status', 'Automated review', '7');
  }
  writeBacklink(1, [comment(`[PR #7](${pr.url}).`)]);
  for (const changes of [
    { state: 'CLOSED' }, { state: 'MERGED' }, { number: 8 },
    { body: 'Refs #10' }, { body: 'Refs other/example#1' }, { body: '' }, { isDraft: true },
  ]) {
    writePR(changes);
    reject('field', '1', 'Status', 'Automated review', '7');
  }
  writePR();
  writeBacklink(1, [comment(pr.url)], { comments: 2 });
  reject('field', '1', 'Status', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { comments: 0 });
  reject('field', '1', 'Status', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { number: 2 });
  reject('field', '1', 'Status', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)], { pull_request: {} });
  reject('field', '1', 'Status', 'Automated review', '7');
  const duplicate = comment(pr.url);
  writeBacklink(1, [duplicate, duplicate]);
  reject('field', '1', 'Status', 'Automated review', '7');
  writeBacklink(1, [comment(pr.url)]);
  for (const failure of ['fail', 'fail-rest']) {
    writeFileSync(join(checkout, failure), '');
    reject('field', '1', 'Status', 'Automated review', '7');
    rmSync(join(checkout, failure));
  }
  writeBacklink(1, Array.from({ length: 100 }, () => comment('Earlier discussion: malformed https://%')).concat(comment(pr.url)));
  writePR({ body: 'Refs #1. Refs test/example#2. Refs test/other#3. Related: #99.' });
  writeBacklink(2, []);
  reject('field', '1', 'Status', 'Automated review', '7', '2');
  writeBacklink(2, [comment(pr.url)]);
  writeBacklink(3, []);
  reject('field', '1', 'Status', 'Automated review', '7', '2', 'test/other#3');
  writeBacklink(3, [comment(`${pr.url}/?view=review#discussion`)]);
  for (const args of [
    ['field', '1', 'Status', 'automated review', '7', '2', 'test/other#3'],
    ['field', '1', 'Status', 'Automated review', '7', '2'],
    ['field', '1', 'Status', 'Automated review', '7', '2'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /backlink.*#1/);
    assert.match(result.stdout, /backlink.*#2/);
  }
  assert.equal(readFileSync(mutations, 'utf8').match(/updateProjectV2ItemFieldValue/g).length, 3);
  assert.equal(JSON.parse(readFileSync(join(checkout, 'backlink-comments-2.json'))).length, 1, 'Repeated verification leaves the existing comment intact');
  writePR({ baseRefName: 'main', body: 'Closes #1' });
  assert.equal(run('field', '1', 'Status', 'Automated review', '7').status, 0, 'Default-branch delivery works too');
});

test('status and priority refuse an unknown flag or extra word, and --help or -h only prints the usage', t => {
  const { checkout, run, refusesUnknownFlag, writeIssue } = fixture(t);
  writeIssue(issue('Ready'));
  refusesUnknownFlag('field', '1', 'Status', 'In progress');
  refusesUnknownFlag('field', '1', 'Priority', 'High');
  // "Automated review" keeps its trailing PR and issues, but a flag among them is still refused.
  assert.equal(run('field', '1', 'Status', 'Automated review', '7', '-x').status, 2);
  for (const flag of ['--help', '-h']) {
    const help = run('field', '1', 'Status', 'In progress', flag);
    assert.equal(help.status, 0, help.stderr);
    assert.ok(help.stdout, `${flag} prints the usage`);
    assert.equal(existsSync(join(checkout, 'queries')), false, `${flag} reached gh`);
  }
});

test('status refuses Done for a spec, by the label of the project file, and writes nothing', t => {
  const { checkout, run, writeIssue } = fixture(t);
  const labelled = name => writeIssue({ ...issue('In progress'), labels: { nodes: [{ name }] } });

  labelled('Spec');
  const result = run('field', '1', 'Status', 'Done');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /^ERROR - BLOCKED: #1 is a spec .*Only a human closes a spec/m);
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'a refused status writes nothing');
  assert.equal(run('field', '1', 'Status', 'Human review').status, 2, 'only a human-invoked spec-review changes spec status');
  assert.equal(run('field', '1', 'Status', 'Human review', '--spec-review').status, 0, 'the skill can hand off a spec without open children');

  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1', specLabel: 'Konzept' }));
  assert.equal(run('field', '1', 'Status', 'Done').status, 0, 'the default label means nothing once the project names its own');
  labelled('Konzept');
  assert.match(run('field', '1', 'Status', 'Done').stdout, /BLOCKED: #1 is a spec \(label "Konzept"\)/);
});
