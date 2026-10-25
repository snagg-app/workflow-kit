import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderReadme } from '../board-readme.mjs';
import { fixture, handoffFixture, handoffPr, issue, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

test('done refuses a spec before acceptance comments or body changes', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Backlog'), labels: { nodes: [{ name: 'spec' }] } });
  writeFileSync(join(checkout, 'result.md'), 'Spec accepted\n\n### Retro\n\n- Keine Funde');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /done is refused/);
  for (const name of ['mutations', 'comment-writes', 'body-writes']) assert.equal(existsSync(join(checkout, name)), false, name);
});

// A checkout with one commit, which the Draft PR 7 shows as its head, and the files the fake gh answers from.
function delivery(t, fixtureOf) {
  const { checkout, run, writeIssue, env, restOverlays } = fixtureOf(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  git('init', '-q', '-b', 'work');
  git('config', 'user.name', 't'); // board.mjs commits its merge with the checkout's own identity
  git('config', 'user.email', 't@t');
  git('commit', '--allow-empty', '-q', '-m', 'pushed');
  git('init', '-q', '--bare', join(dirname(checkout), 'origin.git'));
  git('remote', 'add', 'origin', join(dirname(checkout), 'origin.git'));
  git('push', '-q', 'origin', 'work', 'work:release/0.1.1'); // the base of PR 7 is at the head: nothing to merge
  const head = git('rev-parse', 'HEAD');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  const json = name => JSON.parse(text(name));
  const pr = handoffPr({ id: 'PR7', isDraft: true, headRefName: 'work', headRefOid: head, baseRefOid: head, isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' }, url: 'https://github.com/test/example/pull/7', body: 'Closes #1' });
  pr.commits.nodes[0].commit.oid = head;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('stored'), 'In progress');
  writeFileSync(file('issues-comments.json'), '[]');
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 1, body: '- [ ] first\n- [ ] moved on, see #12\n- [x] done' }));
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, body: 'https://github.com/test/example/pull/7', html_url: 'u' }]));
  writeFileSync(file('result.md'), 'Alles geliefert.\n\n### Retro\n\n- Keine Funde\n');
  writeIssue({ ...issue('In progress'), assignees: { nodes: [{ login: 'worker' }] } });
  return { run, writeIssue, restOverlays, head, file, text, json, git, checkout, env };
}

test('done prepares and hands off the review status without rewriting the review option on resume (#593)', t => {
  for (const status of ['Automated review']) {
    const { run, file, text, json } = delivery(t, handoffFixture);
    writeFileSync(file('status-options.json'), JSON.stringify(['In progress', status, 'Human review']));
    let result = run('done', '1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^PREPARED #1 /m);
    assert.equal(text('stored'), status, 'Write the existing option');
    const mutations = text('mutations');
    result = run('done', '1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text('mutations'), mutations, 'Resume must recognize the alias already stored');
    result = run('done', '1', 'result.md');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text('stored'), 'Human review');
    assert.equal(json('issues-comments.json').length, 1, 'One handoff, with the existing gates');
  }
});

test('done refuses missing review options before merging, pushing or ready mutations (#593 delta)', t => {
  const { run, file, text, json, git, checkout } = delivery(t, handoffFixture);
  moveBase(git, checkout, { 'base.txt': 'moved base' }, { 'own.txt': 'own change' });
  git('push', '-q', 'origin', 'work');
  const head = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: head });
  writeFileSync(file('status-options.json'), JSON.stringify(['In progress', 'Human review']));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /Automated review.*is not an option/);
  assert.equal(git('rev-parse', 'HEAD'), head, 'No base merge');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0], head, 'No push');
  assert.equal(json('pr.json').isDraft, true, 'No ready mutation');
  for (const name of ['mutations', 'comment-writes', 'body-writes', 'affected-tests-calls']) assert.equal(text(name), '', name);
  assert.equal(text('stored'), 'In progress', 'No status mutation');
});

// What GitHub shows of PR 7: the changes, and a head (also the one of its last commit).
function showPr(file, json, { headRefOid, ...changes }) {
  const pr = { ...json('pr.json'), ...changes };
  if (headRefOid) pr.headRefOid = pr.commits.nodes[0].commit.oid = headRefOid;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
}

// The base gets a commit that the branch lacks (files: written in it) and the branch an own commit (files: written in it).
function moveBase(git, checkout, theirs = {}, mine = {}) {
  const commit = (files, message) => {
    for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(checkout, name)), { recursive: true }); writeFileSync(join(checkout, name), content); git('add', name); }
    git('commit', '--allow-empty', '-q', '-m', message);
  };
  git('checkout', '-q', '-b', 'side');
  commit(theirs, 'base moved');
  git('push', '-q', 'origin', 'side:release/0.1.1');
  git('checkout', '-q', 'work');
  git('branch', '-q', '-D', 'side');
  commit(mine, 'own work');
}

function baseMergePolicy(file, json, doneBaseMerge = 'overlap') {
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge }));
}

test('done overlap policy from the remote target base keeps unrelated moves off the pushed head', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'always' }));
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  git('push', '-q', 'origin', 'work');
  const own = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: own });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${own}`));
  assert.equal(readFileSync(join(checkout, '.git', 'board-done-tested'), 'utf8'), own);
  assert.match(text('affected-tests-calls'), /--run/);
  assert.equal(text('stored'), 'Human review');
});

test('done refuses a migration change without a code-review of the head, and goes on once the review is recorded (#1036)', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, {}, { 'backend/db/migration/V1__ä.sql': 'select 1' });
  git('push', '-q', 'origin', 'work');
  const own = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: own });
  assert.equal(run('done', '1', 'result.md').status, 1);
  assert.equal(text('affected-tests-calls'), '', 'refused before the tests');

  execFileSync(process.execPath, [new URL('../review-marker.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { cwd: checkout, env: isolatedGit(dirname(checkout)) });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('stored'), 'Human review');
});

test('done asks for a code-review of the paths the project lists, and for no migration once the list leaves it out (#1042)', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap', reviewRequiredPaths: ['src/**/security/*.java'] }));
  moveBase(git, checkout, {}, { 'backend/db/migration/V1__a.sql': 'select 1', 'src/app/security/Guard.java': 'class Guard {}' });
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  const refused = run('done', '1', 'result.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /Guard\.java/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /V1__a/);

  execFileSync(process.execPath, [new URL('../review-marker.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { cwd: checkout, env: isolatedGit(dirname(checkout)) });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('stored'), 'Human review');
});

test('done asks for no code-review of a migration when the project lists no path (#1042)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap', reviewRequiredPaths: [] }));
  moveBase(git, checkout, {}, { 'backend/db/migration/V1__a.sql': 'select 1' });
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  assert.equal(run('done', '1', 'result.md').status, 0);
});

test('done in the kit refuses a new script without an affected-tests row before the push (#1046)', t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, {}, { 'scripts/board-readme.mjs': '', 'README.md': renderReadme('<!-- board-commands:start -->\n<!-- board-commands:end -->\n'), 'scripts/brand-new-tool.mjs': '' });
  const remote = git('ls-remote', 'origin', 'refs/heads/work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  const refused = run('done', '1', 'result.md');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout + refused.stderr, /brand-new-tool\.mjs/);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work'), remote, 'nothing was pushed');
  assert.equal(text('affected-tests-calls'), '', 'refused before the tests');
});

test('done does not ask for a code-review when no migration changes', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, {}, { 'fix.txt': 'fix' });
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD') });
  assert.equal(run('done', '1', 'result.md').status, 0);
});

test('done pushes a new local commit even when the overlap policy needs no base merge (#659)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md'); // the PR still shows the old head, so ready may refuse; the push must have happened first
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0], own, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), own, 'No base merge');
});

test('done pushes a local commit that already has a tested marker but is not on the PR (#656)', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, { 'other.txt': 'base' }, { 'fix.txt': 'fix' });
  const own = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, '.git', 'board-done-tested'), own);
  const result = run('done', '1', 'result.md');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/work').split('\t')[0], own, result.stdout + result.stderr);
});

test('done overlap policy merges a shared file even when both edits can merge cleanly', t => {
  const { run, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, { 'shared.txt': 'same' }, { 'shared.txt': 'same' });
  git('push', '-q', 'origin', 'work');
  const own = git('rev-parse', 'HEAD');
  showPr(file, json, { headRefOid: own, isDraft: false });
  assert.equal(run('done', '1', 'result.md').status, 1, 'the merged head must become visible on the PR before delivery');
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, own);
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', merged);
  assert.equal(readFileSync(join(checkout, '.git', 'board-done-tested'), 'utf8'), merged);
  showPr(file, json, { headRefOid: merged });
  assert.equal(run('done', '1', 'result.md').status, 0);
});

for (const [name, theirs, mine] of [
  ['shared-file conflict', { 'a.txt': 'theirs' }, { 'a.txt': 'mine' }],
  ['directory/file conflict with distinct changed paths', { 'path/file.txt': 'theirs' }, { path: 'mine' }],
]) test(`done overlap policy refuses ${name} before tests and status writes`, t => {
  const { run, git, checkout, file, text, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  moveBase(git, checkout, theirs, mine);
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.ok(!existsSync(join(checkout, '.git', 'MERGE_HEAD')));
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
});

for (const policy of [null, 'never']) test(`done rejects malformed base merge policy ${policy} before writes`, t => {
  const { run, git, file, text, json, head } = delivery(t, handoffFixture);
  baseMergePolicy(file, json, policy);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
  assert.equal(json('pr.json').isDraft, true);
});

test('done overlap comparison fails closed when the fetched PR base does not exist', t => {
  const { run, git, file, text, json, head } = delivery(t, handoffFixture);
  baseMergePolicy(file, json);
  showPr(file, json, { baseRefName: 'missing' });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(text('affected-tests-calls'), '');
  assert.equal(text('stored'), 'In progress');
});

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
    env.SONAR_TOKEN = ''; // Use the fake check summary, never a developer's token.
    const data = json('pr.json'), contexts = data.commits.nodes[0].commit.statusCheckRollup.contexts;
    contexts.nodes.push({ __typename: 'CheckRun', name: 'SonarCloud Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS',
      summary: `[${count} New issues]`, detailsUrl: 'https://sonarcloud.io/dashboard?id=test_example&pullRequest=7',
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

test('done merges a base the branch is behind, pushes it and tests the merged head; a second call adds no merge commit', t => {
  const { run, head, git, checkout, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('base-project.json'), text('.github/workflow-project.json')); // target base omits the setting: always wins over a local overlap override
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge: 'overlap' }));
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head); // the last fetch is older than the base: done fetches it itself
  showPr(file, json, { isDraft: false }); // ready() refuses at once: the PR still shows the old head
  assert.equal(run('done', '1', 'result.md').status, 1);
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, head);
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', merged);
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${merged}`), 'the merge is pushed');
  assert.equal(readFileSync(join(checkout, '.git', 'board-done-tested'), 'utf8'), merged, 'the merged head was tested');

  showPr(file, json, { headRefOid: merged });
  assert.equal(run('done', '1', 'result.md').status, 0);
  assert.equal(git('rev-parse', 'HEAD'), merged, 'a branch that has the base gets no merge commit');
  assert.match(text('affected-tests-calls'), /--run/);
});

test('done pushes the merged base to its own branch although the upstream is the base (#651)', t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head);
  git('branch', '--set-upstream-to=origin/release/0.1.1');
  showPr(file, json, { isDraft: false });
  assert.equal(run('done', '1', 'result.md').status, 1);
  const merged = git('rev-parse', 'HEAD');
  assert.notEqual(merged, head);
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${merged}`), 'the merge is pushed to the branch');
  assert.equal(git('rev-parse', '--abbrev-ref', '@{u}'), 'origin/work');
});

// The origin answers the fetch of `done` by a script that fails `message` the first `fails` times (stderr like git's), then serves the real upload-pack; it counts its calls.
function flakyFetch(git, checkout, fails, message) {
  writeFileSync(join(checkout, 'upload-pack.sh'), `echo x >> attempts\n[ "$(wc -l < attempts)" -le ${fails} ] && { echo "${message}" >&2; exit 1; }\nexec git upload-pack "$1"\n`);
  git('config', 'remote.origin.uploadpack', 'sh upload-pack.sh');
  return () => readFileSync(join(checkout, 'attempts'), 'utf8').trim().split('\n').length;
}

test('done repeats the fetch of the base when a ref is locked by a parallel fetch, and goes on', t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head);
  showPr(file, json, { isDraft: false });
  const attempts = flakyFetch(git, checkout, 2, "error: cannot lock ref 'refs/remotes/origin/release/0.1.1': is at x but expected y");
  run('done', '1', 'result.md');
  assert.equal(attempts(), 3, 'two refusals, then the third try fetched');
  git('merge-base', '--is-ancestor', 'origin/release/0.1.1', 'HEAD');
});

test('done does not repeat a fetch that fails for another reason', t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('update-ref', 'refs/remotes/origin/release/0.1.1', head);
  showPr(file, json, { isDraft: false });
  const attempts = flakyFetch(git, checkout, 9, 'fatal: Could not read from remote repository.');
  const result = run('done', '1', 'result.md');
  assert.equal(attempts(), 1);
  assert.match(result.stdout, /cannot fetch the base origin\/release\/0\.1\.1/);
});

for (const policy of ['always', 'overlap']) test(`done ${policy} does not merge a base that moved after the tests of this head: repeated calls only wait`, t => {
  const { run, head, git, checkout, file, json } = delivery(t, handoffFixture);
  baseMergePolicy(file, json, policy);
  moveBase(git, checkout);
  const own = git('rev-parse', 'HEAD');
  writeFileSync(join(checkout, '.git', 'board-done-tested'), own);
  showPr(file, json, { isDraft: false, headRefOid: own });
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git('rev-parse', 'HEAD'), own, 'no merge');
  assert.match(git('ls-remote', 'origin', 'refs/heads/work'), new RegExp(`^${head}`), 'no push');
});

test('done neither merges nor pushes a checkout that is not on the PR branch', t => {
  const { run, git, checkout, text } = delivery(t, handoffFixture);
  moveBase(git, checkout);
  git('checkout', '-q', '-b', 'other');
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /not on the branch work/);
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/other'), '');
  assert.equal(text('affected-tests-calls'), '');
});

test('done fails on a conflict with the base, names the files and leaves no merge behind', t => {
  const { run, git, checkout, text } = delivery(t, handoffFixture);
  moveBase(git, checkout, { 'a.txt': 'theirs' }, { 'a.txt': 'mine' });
  const own = git('rev-parse', 'HEAD');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker: .*a\.txt/);
  assert.ok(!existsSync(join(checkout, '.git', 'MERGE_HEAD')), 'the merge was aborted');
  assert.equal(git('rev-parse', 'HEAD'), own);
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(text('affected-tests-calls'), '', 'the tests did not run');
});

test('done does not abort a merge the user resolved and has not committed yet', t => {
  const { run, git, checkout, text } = delivery(t, handoffFixture);
  moveBase(git, checkout, { 'a.txt': 'theirs' }, { 'a.txt': 'mine' });
  const own = git('rev-parse', 'HEAD');
  try { git('merge', '--no-commit', 'origin/release/0.1.1'); } catch { /* the conflict is resolved below */ }
  writeFileSync(join(checkout, 'a.txt'), 'resolved');
  git('add', 'a.txt');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /commit the resolved merge, then run done again/);
  assert.ok(existsSync(join(checkout, '.git', 'MERGE_HEAD')), 'the resolved merge is still in progress');
  assert.equal(git('rev-parse', 'HEAD'), own, 'no commit was made or aborted');
  assert.equal(git('diff', '--cached', '--name-only'), 'a.txt', 'the resolved file is still staged');
  assert.equal(text('affected-tests-calls'), '', 'the tests did not run');
});


test('done counts --max-minutes from its start, so slow tests leave less time to wait and the call ends before the shell limit', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  const pending = json('pr.json');
  pending.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS', conclusion: null }];
  writeFileSync(file('pr.json'), JSON.stringify(pending));
  writeFileSync(file('affected-tests-seconds'), '2');
  const result = run('done', '1', 'result.md', '--max-minutes', '0.05'); // 3 s, of which the tests (2 s) use most
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /^still waiting: call done again$/m);
  // Only the wait itself is timed (its own line), not the whole process: start-up and teardown of the child grow under load (#967).
  // The wait gets at most the 1 s left of the 3 s; a full period of its own would take 3 s.
  const waited = Number(/^done: CI and reviews took ([\d.]+) s$/m.exec(result.stdout)?.[1]);
  assert.ok(waited < 2.5, `the wait did not start its own full period after the tests (took ${waited} s)`);
});

test('done closes a PR without a change, puts the result on the issue and moves it to Human review', t => {
  const { run, file, text, json } = delivery(t, handoffFixture);
  writeFileSync(file('pr.json'), JSON.stringify({ ...json('pr.json'), changedFiles: 0 }));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^CLOSED PR #7 /m);
  assert.equal(json('pr.json').state, 'CLOSED');
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '', 'nothing to test');
});

for (const path of ['fix.txt', ' ']) test(`done refuses stale zero-file metadata when immutable Git contains a pushed change (${JSON.stringify(path)})`, t => {
  if (path === ' ' && process.platform === 'win32') return t.skip('Win32 Git rejects whitespace-only paths; Linux CI covers this Git-diff regression');
  const { run, file, text, json, git, restOverlays } = delivery(t, handoffFixture);
  writeFileSync(file(path), 'real fix');
  git('add', path);
  git('commit', '-q', '-m', 'fix');
  git('push', '-q', 'origin', 'work');
  showPr(file, json, { headRefOid: git('rev-parse', 'HEAD'), changedFiles: 0 });
  restOverlays([{ changedFiles: 0 }, { changedFiles: 1 }]);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('stored'), 'In progress');
  assert.equal(text('affected-tests-calls'), '');
});

for (const [name, first, second] of [
  ['changed remote head', {}, { headRefOid: 'b'.repeat(40) }],
  ['changed remote base', {}, { baseRefOid: 'b'.repeat(40) }],
  ['contradictory counter', {}, { changedFiles: 1 }],
  ['unreadable base commit', { baseRefOid: 'b'.repeat(40) }, {}],
  ['head differs from checkout', { headRefOid: 'b'.repeat(40) }, {}],
]) test(`done leaves issue and PR untouched for no-change ${name}`, t => {
  const { run, file, text, json, restOverlays } = delivery(t, handoffFixture);
  restOverlays([{ changedFiles: 0, ...first }, second]);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('stored'), 'In progress');
});

for (const action of ['push', 'delete']) test(`done refuses a live remote ${action} hidden by stale empty PR metadata`, t => {
  const { run, file, text, json, git } = delivery(t, handoffFixture);
  git('checkout', '-q', '-b', 'other');
  writeFileSync(file('fix.txt'), 'remote fix');
  git('add', 'fix.txt');
  git('commit', '-q', '-m', 'remote fix');
  git('push', '-q', 'origin', 'other:work');
  if (action === 'delete') git('push', '-q', 'origin', '--delete', 'work');
  git('checkout', '-q', 'work');
  showPr(file, json, { changedFiles: 0 }); // stale local checkout and both PR reads still point at the empty head
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED\nblocker:/);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('stored'), 'In progress');
});

test('done refuses to push from a checkout on main or release/** and changes nothing (#646)', t => {
  const { run, git, text, file, checkout } = delivery(t, handoffFixture);
  git('switch', '-C', 'release/0.1.1');
  writeFileSync(join(checkout, '.git/hooks/pre-push'), `#!/bin/sh\necho push >> "${checkout.replaceAll('\\', '/')}/pushes"\n`, { mode: 0o755 });
  const result = run('done', '1', 'result.md');
  assert.equal(existsSync(join(checkout, 'pushes')), false, 'no push attempt');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED/m);
  assert.equal(text('stored'), 'In progress');
  assert.equal(existsSync(file('mutations')), false);
});

test('done without any PR puts the result on the issue, ticks the boxes and moves it to Human review only with --no-pr (#646)', t => {
  const { run, text, json } = delivery(t, fixture); // no PR closes the issue
  let result = run('done', '1');
  assert.equal(result.status === 0, false, 'no PR and no file');
  assert.equal(text('stored'), 'In progress');
  result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, 'a FILE alone does not set the status');
  assert.match(result.stdout, /no PR for #1, so the status stays/);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
  result = run('done', '1', 'result.md', '--no-pr');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^DONE #1 \(no PR\)/m);
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.equal(json('backlink-1.json').body, '- [x] first\n- [ ] moved on, see #12\n- [x] done');
  assert.equal(text('stored'), 'Human review');
  assert.equal(text('affected-tests-calls'), '', 'nothing to test');
});

test('done --no-pr run again after a later step failed writes the result comment only once (#993)', t => {
  const { run, text, file, json } = delivery(t, fixture);
  assert.equal(run('done', '1', 'result.md', '--no-pr').status, 0);
  writeFileSync(file('stored'), 'In progress'); // the status step did not land
  const again = run('done', '1', 'result.md', '--no-pr');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(json('issues-comments.json').length, 1, 'one result comment');
  assert.equal(text('stored'), 'Human review');
});

test('done without a PR refuses when the issue carries a claim but no commit yet, and changes nothing (#907)', t => {
  const { run, writeIssue, text, json } = delivery(t, fixture); // the branch has no commit of its own
  writeIssue({ ...issue('In progress'), assignees: { nodes: [{ login: 'worker' }] }, comments: { nodes: [{ body: 'Agent: claude, Session: S907\nBasis: release/0.1.1' }] } });
  const result = run('done', '1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
});

const mergedDelivery = { number: 7, state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) }, repository: { nameWithOwner: 'test/example' } };
const closedDelivery = () => ({ ...issue('Done'), state: 'CLOSED', stateReason: 'COMPLETED',
  closedByPullRequestsReferences: { totalCount: 1, nodes: [mergedDelivery] } });

test('done Prepare then external merge then FILE preserves Done, body and comments with readable merge evidence', t => {
  const { run, file, text, json, writeIssue } = delivery(t, handoffFixture);
  assert.equal(run('done', '1').status, 0, 'Prepare succeeds before the external merge');
  showPr(file, json, { state: 'MERGED', mergeCommit: mergedDelivery.mergeCommit });
  writeIssue(closedDelivery());
  writeFileSync(file('stored'), 'Done');
  const before = ['stored', 'backlink-1.json', 'issues-comments.json', 'mutations', 'affected-tests-calls'].map(text);
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALREADY DONE #1: closed as completed; PR #7 merged \(f{40}\); no changes/);
  assert.deepEqual(['stored', 'backlink-1.json', 'issues-comments.json', 'mutations', 'affected-tests-calls'].map(text), before);
});

test('done re-reads external closure before the first No-PR mutation', t => {
  const { run, file, text, json } = delivery(t, fixture);
  writeFileSync(file('issue-next.json'), JSON.stringify(closedDelivery()));
  writeFileSync(file('stored'), 'Done');
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALREADY DONE #1/);
  assert.equal(text('stored'), 'Done');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('mutations'), '');
  assert.equal(text('affected-tests-calls'), '');
  assert.ok(text('queries').split('\n').some(line => line.includes('includeClosedPrs:true')), 'closed PRs must be requested from GitHub');
});

for (const [name, changes] of [
  ['unreadable issue state', { state: null }],
  ['unreadable closure reason', { stateReason: null }],
  ['not-planned closure', { stateReason: 'NOT_PLANNED' }],
  ['incomplete PR list', { closedByPullRequestsReferences: { totalCount: 2, nodes: [mergedDelivery] } }],
  ['unreadable PR state', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, state: null }] } }],
  ['unreadable merge commit', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, mergeCommit: null }] } }],
  ['unmerged linked PR', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, state: 'CLOSED' }] } }],
  ['unrelated merged PR', { closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, repository: { nameWithOwner: 'other/repo' } }] } }],
  ['new open PR', { state: 'OPEN', closedByPullRequestsReferences: { totalCount: 1, nodes: [{ ...mergedDelivery, state: 'OPEN' }] } }],
]) test(`done refuses No-PR ${name} before any mutation`, t => {
  const { run, file, text, json } = delivery(t, fixture);
  writeFileSync(file('issue-next.json'), JSON.stringify({ ...closedDelivery(), ...changes }));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAILED\nblocker: cannot confirm issue closure for #1/);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('mutations'), '');
  assert.equal(text('affected-tests-calls'), '');
});

test('done delivers a human-reopened issue through the existing No-PR handoff', t => {
  const { run, text, json, writeIssue } = delivery(t, fixture);
  writeIssue({ ...closedDelivery(), state: 'OPEN', stateReason: 'REOPENED' });
  const result = run('done', '1', 'result.md', '--no-pr');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^DONE #1 \(no PR\)/m);
  assert.equal(text('stored'), 'Human review');
  assert.match(json('issues-comments.json').at(-1).body, /^## Übergabe\n\nAlles geliefert\./);
  assert.ok(json('backlink-1.json').body.startsWith('- [x] first'));
});

test('done leaves issue untouched when the API closure read fails', t => {
  const { run, file, text, json } = delivery(t, fixture);
  writeFileSync(file('fail'), '');
  const result = run('done', '1', 'result.md');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /test\/example#1/);
  assert.equal(text('stored'), 'In progress');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
  assert.equal(text('mutations'), '');
});

test('done hands a partial PR off without a native link, status or ticked boxes, also when no other PR closes the issue', t => {
  const { run, writeIssue, text, json } = delivery(t, fixture);
  // No PR closes the issue: the PR only names it, and the issue is neither assigned nor in review.
  writeIssue(issue('In progress'));
  const result = run('done', '1', '7', 'result.md', '--refs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^HANDOFF #1 PR #7 /m);
  assert.equal(text('stored'), 'In progress', 'the issue status stays');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'the boxes of the issue stay open');
  assert.equal(json('pr.json').isDraft, false);
});

test('done keeps an empty --refs PR on the regular test and review path', t => {
  const { run, file, text, json } = delivery(t, handoffFixture);
  showPr(file, json, { changedFiles: 0 });
  const result = run('done', '1', '7', 'result.md', '--refs');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(json('pr.json').state, 'OPEN');
  assert.match(text('affected-tests-calls'), /--run/);
  assert.equal(text('stored'), 'In progress');
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'));
});

test('done with a handoff file moves a head without handoff off Human review and leaves it there after a red wait (#947)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  writeFileSync(file('stored'), 'Human review');
  const pr = json('pr.json');
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = [{ __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }];
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), [], 'no handoff for a red head');
});

test('done ends a PR without any check as a blocker instead of waiting forever (#947)', t => {
  const { run, file, json } = delivery(t, handoffFixture);
  const pr = json('pr.json');
  const commit = pr.commits.nodes[0].commit;
  commit.statusCheckRollup.contexts = { totalCount: 0, nodes: [] };
  commit.checkSuites = { totalCount: 0, nodes: [] };
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md', '--max-minutes', '0.01');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /no CI run on the head/);
});

test('done writes no handoff when another push changed the head during the wait (#947)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  // The REST reads before the wait show the pushed head; the next one shows a foreign push.
  const foreign = 'b'.repeat(40), commits = json('pr.json').commits;
  commits.nodes[0].commit.oid = foreign;
  writeFileSync(file('pr-rest-reads.json'), JSON.stringify([...Array(4).fill({}), { headRefOid: foreign, commits }]));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /head changed while waiting/);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
});

test('done reports a PR merged during the wait and changes nothing on the issue (#982)', t => {
  const { run, json, text, checkout } = delivery(t, handoffFixture);
  writeFileSync(join(checkout, 'pr-reads.json'), JSON.stringify([...Array(1).fill({}), { state: 'MERGED' }]));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ALREADY MERGED #1/m);
  assert.doesNotMatch(result.stdout + result.stderr, /TypeError/);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'no ticks');
});

test('done ticks and posts nothing while the wait ends on a blocker only (#982)', t => {
  const { run, file, json, text } = delivery(t, handoffFixture);
  const pr = json('pr.json');
  pr.latestOpinionatedReviews = { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] };
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  const result = run('done', '1', 'result.md');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker: changes requested by reviewer/m);
  assert.equal(text('stored'), 'Automated review');
  assert.deepEqual(json('issues-comments.json'), []);
  assert.ok(json('backlink-1.json').body.startsWith('- [ ] first'), 'no ticks');
});
