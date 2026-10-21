import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { handoffFixture, handoffComment, handoffPr, issue, test } from './board-fixture.mjs';


test('handoff needs the driver handoff comment that names the current head', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const mutations = join(checkout, 'mutations');
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const write = comments => writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
  for (const [label, comments] of [
    ['no comment at all', []],
    ['another heading', [handoffComment({ body: 'Review ist durch' })]],
    ['the heading only inside a sentence', [handoffComment({ body: 'siehe ## Übergabe unten' })]],
    ['another author', [handoffComment({ user: { login: 'someone-else', type: 'User' } })]],
    ['no head named (the format before this check)', [handoffComment({ body: '## Übergabe\n\n- Retro: keine Befunde' })]],
    ['another head named, e.g. a comment for the previous push', [handoffComment({ body: '## Übergabe\n\nHead: 1234567\n\n- Retro: keine Befunde' })]],
    ['the head named only inside a sentence', [handoffComment({ body: '## Übergabe\n\nFür Head: abcdef1 siehe oben (Zeile beginnt anders)' })]],
  ]) {
    write(comments);
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^FAILED$/m, label);
    assert.equal(existsSync(mutations), false, `${label}: the status stays untouched`);
  }
  // No timestamp is involved: a head without any check suite (CI reported only as a status) works, and so does a comment
  // that is older than the head's suite, because it names the head.
  const base = handoffPr();
  write([handoffComment({ created_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z' })]);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ commits: { nodes: [{ commit: { ...base.commits.nodes[0].commit, checkSuites: { totalCount: 0, nodes: [] } } }] } })));
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  assert.equal(run('handoff', '1', '7').status, 0, 'Naming the head is enough, with or without a check suite');
  rmSync(join(checkout, 'stored'));
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(base));
  write([handoffComment({ user: { login: 'Worker', type: 'User' }, body: '## Übergabe\n\nhead:   ABCDEF1234\n' })]);
  const result = run('handoff', '1', '7');
  assert.equal(result.status, 0, 'The authenticated user matches regardless of case: ' + result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Human review');
});

test('handoff follows the status names and the language of the project file', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const config = join(checkout, '.github/workflow-project.json'), { language, ...plain } = JSON.parse(readFileSync(config, 'utf8'));
  writeFileSync(config, JSON.stringify({ ...plain, statuses: { automatedReview: 'Checks', humanReview: 'QA' } }));
  writeFileSync(join(checkout, 'status-options.json'), JSON.stringify(['Backlog', 'Ready', 'In progress', 'Checks', 'QA', 'Done']));
  writeIssue({ ...issue('Checks'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  // Without "language" the heading is English: the German one is another heading.
  assert.equal(run('handoff', '1', '7').status, 1, 'a "## Übergabe" comment is no handoff in an English project');
  assert.equal(existsSync(join(checkout, 'mutations')), false);
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([handoffComment({ body: '## Handoff\n\nHead: abcdef1' })]));
  const result = run('handoff', '1', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'QA');
});


// The PR body as GitHub renders it: headings and paragraphs, with the checks the "selfReview" field of the project file lists.
const selfReview = (level, ...lines) => `<h${level} dir="auto">Selbstprüfung</h${level}>\n` + lines.map(line => `<p dir="auto">${line}</p>`).join('\n');

test('handoff needs the Selbstprüfung section of the PR body to name every check the project lists, and nothing without the field', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  const config = join(checkout, '.github/workflow-project.json'), plain = JSON.parse(readFileSync(config, 'utf8'));
  const project = changes => writeFileSync(config, JSON.stringify({ ...plain, ...changes }));
  const handoff = (bodyHTML, changes = { selfReview: ['ponytail-review', 'code-review'] }) => {
    project(changes);
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ bodyHTML })));
    return run('handoff', '1', '7');
  };
  const both = '<code>ponytail-review</code>: nichts mehr zu streichen. <code>code-review</code>: ein Fund, behoben.';
  // The reason names what is missing.
  const rejected = (bodyHTML, named, label) => {
    const result = handoff(bodyHTML);
    assert.equal(result.status, 1, label + result.stdout + result.stderr);
    const blockers = result.stdout.split('\n').filter(line => line.startsWith('blocker:'));
    assert.equal(blockers.length, 1, label + result.stdout);
    for (const name of named) assert.ok(blockers.some(line => line.includes('Selbstprüfung') && line.includes(name)), label + result.stdout);
    assert.equal(existsSync(join(checkout, 'mutations')), false, label + 'Rejected handoff never mutates status');
  };
  const checks = ['ponytail-review', 'code-review'];

  rejected('<p>Beschreibung</p>', checks, 'no section: ');
  rejected(`<h2 dir="auto">Reviews</h2>\n<p>${both}</p>`, checks, 'the names under another heading: ');
  rejected(`<blockquote>\n${selfReview(2, both)}\n</blockquote>`, checks, 'a quoted template is no section: ');
  rejected(selfReview(2, '<code>pony</code>', '<code>tail-review</code>', 'code-review: ok'), ['ponytail-review'], 'names split across paragraphs do not join: ');
  rejected(selfReview(2, '<code>code-review</code>: ein Fund.'), ['ponytail-review'], 'one check missing: ');
  rejected(selfReview(2, 'ponytail-review: ok', 'code-reviewÄnderung'), ['code-review'], 'a Unicode suffix is part of the word: ');

  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  for (const [html, label] of [
    [selfReview(2, both), 'both names'],
    [`<p>Intro</p>\n${selfReview(3, 'ponytail-review, CODE-REVIEW')}\n<h2 dir="auto">Randfälle</h2>`, 'a level-3 heading, any case'],
    [`${selfReview(2)}\n<h3 dir="auto">ponytail-review</h3>\n<p>ok</p>\n<h3 dir="auto">code-review</h3>\n<p>ok</p>`, 'sub-headings belong to the section'],
  ]) {
    const result = handoff(html);
    assert.equal(result.status, 0, label + ': ' + result.stdout + result.stderr);
  }
  // Without the field, or with an empty list, a PR body without the section hands off as before; a malformed field is an ERROR.
  for (const changes of [{}, { selfReview: [] }]) {
    const result = handoff(undefined, changes);
    assert.equal(result.status, 0, JSON.stringify(changes) + result.stdout + result.stderr);
  }
  for (const bad of [null, 'ponytail-review', [''], [1]]) assert.equal(handoff(selfReview(2, both), { selfReview: bad }).status, 2, JSON.stringify(bad));
  assert.equal(handoff(undefined).status, 2, 'An unreadable rendered PR body is unknown, never a handoff');

  const pending = { reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: { login: 'reviewer' } }] },
    requestEvents: { totalCount: 1, nodes: [{ createdAt: new Date().toISOString(), requestedReviewer: { login: 'reviewer' } }] } };
  project({ selfReview: ['ponytail-review'] });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ ...pending, bodyHTML: undefined })));
  assert.equal(run('handoff', '1', '7').status, 2, 'An unreadable PR body is an error even while a reviewer is pending');
  project({ selfReview: null });
  assert.equal(run('handoff', '1', '7').status, 2, 'A malformed config is an error even while a reviewer is pending');
});


test('handoff blocks on open Sonar issues behind a passed quality gate and never reads an unreadable count as clean', t => {
  const { checkout, run, writeIssue, env } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  const base = handoffPr(), commit = base.commits.nodes[0].commit;
  const sonar = { __typename: 'CheckRun', name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS',
    detailsUrl: 'https://sonarcloud.io/dashboard?id=test_example&pullRequest=7', checkSuite: { app: { slug: 'sonarqubecloud' } } };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...base, commits: { nodes: [{ commit: { ...commit,
    statusCheckRollup: { contexts: { totalCount: 2, nodes: [...commit.statusCheckRollup.contexts.nodes, sonar] } } } }] } }));
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  // Stands in for the Sonar API in every node process of the run, the board's request child included.
  writeFileSync(join(checkout, 'sonar-mock.cjs'), `const fs = require('node:fs');
globalThis.fetch = async (url, init) => {
  fs.appendFileSync('sonar-requests', JSON.stringify([String(url), init.headers.Authorization]) + '\\n');
  const { status, total, issues } = JSON.parse(fs.readFileSync('sonar.json', 'utf8'));
  return { ok: status === 200, status, text: async () => JSON.stringify({ total, issues }) };
};`);
  env.NODE_OPTIONS = `--require "${join(checkout, 'sonar-mock.cjs').replaceAll(sep, '/')}"`;
  env.SONAR_TOKEN = 'secret-token';
  const answer = (status, total, issues = []) => writeFileSync(join(checkout, 'sonar.json'), JSON.stringify({ status, total, issues }));
  const finding = (rule, file, line, message) => ({ rule, component: `test_example:${file}`, line, message });
  const mutations = join(checkout, 'mutations');

  answer(200, 2, [finding('java:S3776', 'src/A.java', 42, 'Refactor this method\nto reduce its Cognitive Complexity'), finding('java:S1135', 'src/B.java', undefined, 'Complete the task')]);
  let result = run('handoff', '1', '7');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker:/m);
  // Rule, file, line and message of each finding, the token never.
  assert.match(result.stdout, /^sonar: java:S3776 src\/A\.java:42 Refactor this method to reduce its Cognitive Complexity$/m);
  assert.match(result.stdout, /^sonar: java:S1135 src\/B\.java Complete the task$/m);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-token/);

  // The list is capped; the rest is only counted.
  answer(200, 12, Array.from({ length: 12 }, (_, index) => finding('java:S1', `src/F${index}.java`, index + 1, 'm')));
  result = run('handoff', '1', '7');
  assert.equal(result.stdout.match(/^sonar: java:S1 /gm).length, 10, result.stdout);
  assert.match(result.stdout, /^sonar: … 2 more$/m);
  assert.equal(existsSync(mutations), false, 'Open Sonar issues keep the status untouched');
  const [requested, authorization] = JSON.parse(readFileSync(join(checkout, 'sonar-requests'), 'utf8').split('\n')[0]);
  assert.equal(authorization, 'Bearer secret-token', 'The anonymous API reports 0 for private projects');
  const query = new URL(requested).searchParams;
  assert.deepEqual([query.get('componentKeys'), query.get('pullRequest'), query.get('issueStatuses')], ['test_example', '7', 'OPEN,CONFIRMED']);

  answer(401, 0);
  result = run('handoff', '1', '7');
  assert.equal(result.status, 2, 'A refused read is UNKNOWN, not green: ' + result.stdout + result.stderr);
  env.SONAR_TOKEN = ''; // overrides a token of the developer's own environment
  answer(200, 0);
  // Without a token the count is read from the check run's own summary; only an unambiguous number counts.
  const summarized = summary => writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...base, commits: { nodes: [{ commit: { ...commit,
    statusCheckRollup: { contexts: { totalCount: 2, nodes: [...commit.statusCheckRollup.contexts.nodes, { ...sonar, summary }] } } } }] } }));
  for (const summary of [undefined, 'Quality Gate passed', '[x New issues](https://sonarcloud.io)']) {
    summarized(summary);
    result = run('handoff', '1', '7');
    assert.equal(result.status, 1, 'An unreadable count is never clean: ' + result.stdout + result.stderr);
    assert.match(result.stdout, /^blocker: .*SONAR_TOKEN/m);
  }
  summarized('![](x.svg) [2 New issues](https://sonarcloud.io/project/issues?id=test_example)');
  result = run('handoff', '1', '7');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker: 2 open Sonar issues/m);
  assert.equal(existsSync(mutations), false);
  summarized('![](x.svg) [0 New issues](https://sonarcloud.io/project/issues?id=test_example)');
  result = run('handoff', '1', '7');
  assert.equal(result.status, 0, 'A readable 0 hands off without a token: ' + result.stdout + result.stderr);
  rmSync(join(checkout, 'stored'));
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...base, commits: { nodes: [{ commit: { ...commit,
    statusCheckRollup: { contexts: { totalCount: 2, nodes: [...commit.statusCheckRollup.contexts.nodes, sonar] } } } }] } }));

  env.SONAR_TOKEN = 'secret-token';
  result = run('handoff', '1', '7');
  assert.equal(result.status, 0, 'No open issue hands off: ' + result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Human review');

  // A skipped check ran no analysis (no PR link to read): it is no lookup, however many issues the project has.
  rmSync(join(checkout, 'stored'));
  answer(200, 9);
  const skipped = { ...sonar, conclusion: 'SKIPPED', detailsUrl: null };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...base, commits: { nodes: [{ commit: { ...commit,
    statusCheckRollup: { contexts: { totalCount: 2, nodes: [...commit.statusCheckRollup.contexts.nodes, skipped] } } } }] } }));
  result = run('handoff', '1', '7');
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
