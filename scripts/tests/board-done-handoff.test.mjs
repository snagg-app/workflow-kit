import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { handoffFixture, issue, test } from './board-fixture.mjs';
import { delivery, showPr, moveBase } from './board-done-fixture.mjs';

test('done takes the pushed work to Human review: tests, ready, ticked boxes, Automated review, wait, handoff comment', t => {
  const { run, head, text, json, git } = delivery(t, handoffFixture);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), head, 'a branch with its base gets no merge commit');
  assert.match(result.stdout, /HANDOFF #1/);
  assert.match(text('affected-tests-calls'), /--run/, 'the targeted tests ran');
  assert.equal(json('pr.json').isDraft, false, 'the PR is ready');
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done', 'the box without a follow-up is ticked');
  assert.equal(text('stored'), 'Human review');
  const posted = json('issues-comments.json').at(-1).body;
  assert.match(posted, new RegExp(`^## Übergabe\\n\\nHead: ${head.slice(0, 7)}\\n\\nAlles geliefert\\.\\n\\n### Retro`));

  // The same call again: the comment for this head exists, so there is no second one.
  const comments = json('issues-comments.json').length;
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(json('issues-comments.json').length, comments);
  // ... and without the file, as after exit 4, the call still passes.
  assert.equal(run('done', '1').status, 0);
});

test('done lists tests that are red on the base too in the handoff, before the Retro, and names their open issue (#1052)', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  writeFileSync(file('affected-tests-base-red'), 'io.snagg.StashServiceTest.addsItem\n');
  writeFileSync(file('test-issues.json'), JSON.stringify([{ number: 9, title: 'Test schon rot: StashServiceTest', body: '', html_url: 'https://github.com/test/example/issues/9' }]));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const posted = json('issues-comments.json').at(-1).body;
  assert.match(posted, /`io\.snagg\.StashServiceTest\.addsItem`: .*https:\/\/github\.com\/test\/example\/issues\/9/);
  assert.ok(posted.indexOf('issues/9') < posted.indexOf('### Retro'), 'the section comes before the Retro list');
  assert.equal(json('issues-comments.json').length, 1);
  assert.equal(existsSync(file('creates')), false, 'an open issue names the class: nothing is created');
});

test('done keeps the base-red tests of a tested head when the final call skips the local tests (#1052)', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  writeFileSync(file('affected-tests-base-red'), 'io.snagg.StashServiceTest.addsItem\n');
  writeFileSync(file('test-issues.json'), JSON.stringify([{ number: 9, title: 'StashServiceTest', html_url: 'https://github.com/test/example/issues/9' }]));
  assert.equal(run('done', '1').status, 0);
  assert.equal(run('done', '1', 'result.md', '--skip-local-tests', 'tested above').status, 0);
  assert.match(json('issues-comments.json').at(-1).body, /StashServiceTest\.addsItem`: .*issues\/9/);
});

test('done creates the issue of a test that is red on the base, from the milestone, labels and fields of its own issue, and still hands off (#1052)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  const write = (name, data) => writeFileSync(file(name), typeof data === 'string' ? data : JSON.stringify(data));
  write('affected-tests-base-red', 'io.snagg.StashServiceTest.addsItem\n');
  write('test-issues.json', []);
  write('test-milestones.json', [{ number: 4, title: '0.1.1' }]);
  write('test-labels.json', [{ name: 'enhancement' }]);
  write('backlink-1.json', { number: 1, state: 'open', comments: 1, body: '- [ ] first', milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }] });
  write('create-response.json', { number: 12, node_id: 'N12', html_url: 'https://github.com/test/example/issues/12' });
  write('backlink-12.json', { number: 12, state: 'open', comments: 0, milestone: { title: '0.1.1' }, labels: [{ name: 'enhancement' }], assignees: [] });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const created = JSON.parse(text('created.json'));
  assert.deepEqual([created.milestone, created.labels], [4, ['enhancement']]);
  assert.match(text('stored-items.json'), /"PI-N12":\{"F1":"Ready"/, 'the new issue starts on Ready');
  const posted = json('issues-comments.json').at(-1).body;
  assert.match(posted, /`io\.snagg\.StashServiceTest\.addsItem`: .*https:\/\/github\.com\/test\/example\/issues\/12/);
});

test('done hands off even when the issue for a base-red test cannot be created (#1052)', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  writeFileSync(file('affected-tests-base-red'), 'io.snagg.StashServiceTest.addsItem\n');
  writeFileSync(file('test-issues.json'), '[]');
  writeFileSync(file('test-milestones.json'), '[]'); // the milestone of the issue at hand is not open: the creation is refused
  writeFileSync(file('test-labels.json'), '[]');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(json('issues-comments.json').at(-1).body, /`io\.snagg\.StashServiceTest\.addsItem`: .*milestone/);
});

test('done without a handoff file prepares: tests, ready, Automated review, then PREPARED without comment, ticking or Human review; the final done takes the same head', t => {
  const { run, head, text, json, git, file } = delivery(t, handoffFixture);
  const result = run('done', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^PREPARED #1 head ${head.slice(0, 7)}`, 'm'));
  assert.match(text('affected-tests-calls'), /--run/, 'the targeted tests ran');
  assert.equal(json('pr.json').isDraft, false, 'the PR is ready');
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), [], 'no handoff comment');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'the boxes stay open');

  // The final call hands off the same head without repeating the tests.
  const tests = text('affected-tests-calls');
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(text('affected-tests-calls'), tests);
  assert.equal(text('stored'), 'Human review');
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done');
  assert.match(json('issues-comments.json').at(-1).body, new RegExp(`^## Übergabe\\n\\nHead: ${head.slice(0, 7)}`));

  // A head pushed after the preparation is tested again.
  git('commit', '--allow-empty', '-q', '-m', 'later');
  git('push', '-q', 'origin', 'work');
  const later = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: later });
  assert.match(run('done', '1').stdout, new RegExp(`^PREPARED #1 head ${later.slice(0, 7)}`, 'm'));
  assert.notEqual(text('affected-tests-calls'), tests, 'the new head was tested');
  assert.equal(text('stored'), 'Automated review', 'the new head leaves Human review');
});

test('done rejects four Sonar issues before preparation or handoff, and accepts zero (#598)', t => {
  for (const count of [4, 0]) for (const handoff of [false, true]) {
    const { run, file, text, json, env } = delivery(t, handoffFixture);
    env.SONAR_TOKEN = ''; // Never a developer's token; the fake Sonar door answers from sonar.json, a green summary ("0 New issues") counts for nothing (#1055).
    writeFileSync(file('sonar.json'), JSON.stringify({ status: 200, total: count, issues: [] }));
    const data = json('pr.json'), contexts = data.commits.nodes[0].commit.statusCheckRollup.contexts;
    contexts.nodes.push({ __typename: 'CheckRun', name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS',
      summary: '[0 New issues]', detailsUrl: 'https://sonarcloud.io/dashboard?id=test_example&pullRequest=7',
      checkSuite: { app: { slug: 'sonarqubecloud' } } });
    contexts.totalCount = contexts.nodes.length;
    writeFileSync(file('pr.json'), JSON.stringify(data));
    const result = run('done', '1', ...(handoff ? ['result.md'] : []));
    assert.equal(result.status, count ? 1 : 0, result.stdout + result.stderr);
    if (count) {
      assert.match(result.stdout, /^FAILED: 4 open Sonar issues$/m);
      assert.match(result.stdout, /^sonar: 4 open issues$/m);
      assert.match(result.stdout, /^blocker: 4 open Sonar issues on this head/m);
      assert.doesNotMatch(result.stdout, /PREPARED|Run the final proof|HANDOFF/);
      assert.equal(text('stored'), 'Automated review');
      assert.deepEqual(json('issues-comments.json'), [], 'No handoff comment');
      assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'No acceptance ticks');
    } else {
      assert.match(result.stdout, handoff ? /HANDOFF #1/ : /^PREPARED #1 /m);
      assert.equal(text('stored'), handoff ? 'Human review' : 'Automated review');
    }
  }
});

test('done can explicitly skip local tests through preparation and handoff without a tested marker', t => {
  const { run, head, text, json, file } = delivery(t, handoffFixture);
  const reason = 'Historical proof unchanged after base merge';
  const prepared = run('done', '1', '--skip-local-tests', reason);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  assert.match(prepared.stdout, new RegExp(`LOCAL TESTS SKIPPED ${head}: ${reason}`));
  assert.match(prepared.stdout, /PREPARED.*local tests skipped/);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(existsSync(file('.git/board-done-tested')), false);
  assert.equal(json('pr.json').isDraft, false);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  const delivered = run('done', '1', 'result.md', '--skip-local-tests', reason);
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(existsSync(file('.git/board-done-tested')), false);
  assert.match(json('issues-comments.json').at(-1).body, new RegExp(`Head: ${head.slice(0, 7)}`));
});

test('a repeated done --skip-local-tests does not merge a moved base again (#927)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  const reason = 'Proof unchanged';
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  run('done', '1', '--skip-local-tests', reason);
  const merged = git('rev-parse', 'HEAD');
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', merged);
  showPr(file, json, { headRefOid: merged });
  git('checkout', '-q', '-b', 'side', 'origin/release/0.1.1');
  git('commit', '--allow-empty', '-q', '-m', 'base moved again');
  git('push', '-q', 'origin', 'side:release/0.1.1');
  git('checkout', '-q', 'work');
  git('branch', '-q', '-D', 'side');
  run('done', '1', '--skip-local-tests', reason);
  assert.equal(git('rev-parse', 'HEAD'), merged, 'no second merge');
});

test('done skip preserves an old tested SHA and still refuses failed CI on the new head', t => {
  const { run, head, text, json, file, git } = delivery(t, handoffFixture);
  writeFileSync(file('.git/board-done-tested'), head);
  git('commit', '--allow-empty', '-q', '-m', 'new head');
  git('push', '-q', 'origin', 'work');
  const later = git('rev-parse', 'HEAD');
  assert.notEqual(later, head);
  showPr(file, json, { headRefOid: later });
  const pr = json('pr.json');
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md', '--skip-local-tests', 'No local repeat');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('.git/board-done-tested'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
});

for (const reason of [[], [''], ['  '], ['--refs']]) test(`done refuses invalid skip reason ${JSON.stringify(reason)} before mutations`, t => {
  const { run, head, text, json, file, git } = delivery(t, handoffFixture);
  const result = run('done', '1', 'result.md', '--skip-local-tests', ...reason);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
  assert.equal(json('pr.json').isDraft, true);
  for (const name of ['mutations', 'comment-writes', 'body-writes', '.git/board-done-tested']) assert.equal(existsSync(file(name)), false, name);
});

test('done without a handoff file keeps the waiting and failure codes of the review', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  const pr = json('pr.json'), checks = conclusion => { pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion }]; writeFileSync(file('pr.json'), JSON.stringify(pr)); };
  checks(null);
  let result = run('done', '1', '--max-minutes', '0.01');
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /PREPARED/);
  checks('FAILURE');
  result = run('done', '1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /PREPARED/);
  assert.equal(text('stored'), 'Automated review');
});

