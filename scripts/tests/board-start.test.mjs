import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, handoffPr, issue, predecessor, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

test('start refuses a spec before assignment or claim writes', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Ready'), labels: { nodes: [{ name: 'spec' }] } });
  const result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /start is refused/);
  assert.deepEqual(JSON.parse(readFileSync(join(checkout, 'issue.json'), 'utf8')).assignees.nodes, []);
  for (const name of ['mutations', 'created-pr', 'develops']) assert.equal(existsSync(join(checkout, name)), false, name);
});

// A checkout with an origin that already holds the branch of issue 1, and the files the fake gh answers from.
function startFixture(t) {
  const { checkout, run, writeIssue, env } = fixture(t);
  env.CODEX_THREAD_ID = '';
  env.BOARD_FIXTURE_DEVELOP_GIT = '1';
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  const origin = join(dirname(checkout), 'origin.git');
  git(dirname(checkout), 'init', '-q', '--bare', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  // start commits too, so the identity lives in the checkout (a CI runner has none).
  git(checkout, 'config', 'user.name', 't');
  git(checkout, 'config', 'user.email', 't@t');
  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-q', 'origin', 'main');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: true, linkPages: [[]], url: 'https://github.com/test/example/pull/7' })));
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
  writeFileSync(file('backlink-comments-1.json'), '[]');
  return { checkout, run, writeIssue, git, file, text, env };
}

test('start claims without branch or PR; the same call resumes, a foreign claim blocks and --takeover takes it (#643)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);

  // A blocked issue is refused by the check, before anything is written.
  writeIssue(issue('Ready', [predecessor('OPEN', null)]));
  let result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const written of ['develops', 'comment-writes', 'created-pr', 'stored']) assert.equal(existsSync(file(written)), false, written);

  writeIssue(issue('Ready'));
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^START #1 session S1 branch claude\/1-fixture base main \(branch made from origin\/main/m);
  assert.equal(text('stored'), 'In progress');
  assert.equal(JSON.parse(text('issue.json')).assignees.nodes[0].login, 'worker');
  for (const none of ['develops', 'created-pr']) assert.equal(existsSync(file(none)), false, none);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  const claim = JSON.parse(text('backlink-comments-1.json')).map(comment => comment.body).join('');
  assert.match(claim, /Agent: claude, Session: S1\nBasis: main\n/);

  // The same call again writes no second claim; another session is blocked by the claim, --takeover posts its own.
  const claimed = { createdAt: new Date().toISOString(), url: 'u', body: claim };
  writeIssue({ ...JSON.parse(text('issue.json')), comments: { nodes: [claimed] } });
  const writes = text('comment-writes');
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('comment-writes'), writes, 'no second claim');
  result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /claimed by claude \(session S1\)/);
  assert.equal(text('comment-writes'), writes);
  result = run('start', '1', '--session', 'S2', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(JSON.parse(text('backlink-comments-1.json')).at(-1).body, /Session: S2\n/);
});

test('start takes over a stale PR of another session: its claim line names the new session', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  const hoursAgo = new Date(Date.now() - 9 * 3_600_000).toISOString();
  const body = 'Closes #1\nAgent: claude, Session: OLD\nMehr';
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body }));
  writeIssue({ ...issue('In progress'), updatedAt: hoursAgo, closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body, updatedAt: hoursAgo, headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });
  const result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(text('pr.json')).body, 'Closes #1\nAgent: claude, Session: S2\nMehr');
});

test('start --issue-repo claims the issue of the other repository, only start and done take the option', t => {
  const { run, writeIssue, text } = startFixture(t);
  writeIssue(issue('Ready'));
  const result = run('--issue-repo', 'test/kit', 'start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^test\/kit#1 Fixture$/m);
  const asked = text('repositories').split('\n');
  assert.ok(asked.includes('issue owner=test/name=kit') && !asked.includes('issue owner=test/name=example'), 'the issue is looked up in the other repository only');
  assert.equal(run('--issue-repo', 'test/kit', 'check', '1').status, 2);
});

test('done opens the branch and the Draft PR with the first push (#643)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  writeIssue(issue('Ready'));
  assert.equal(run('start', '1', '--session', 'S1').status, 0);
  const body = 'Beansprucht.\nAgent: claude, Session: S1\nBasis: main\n';
  writeIssue({ ...JSON.parse(text('issue.json')), comments: { nodes: [{ createdAt: new Date().toISOString(), url: 'u', body }] } });
  writeFileSync(file('work.txt'), 'x');
  git(checkout, 'add', 'work.txt');
  git(checkout, 'commit', '-q', '-m', 'work');
  run('done', '1'); // goes on to tests and ready; only the opening is asserted
  const created = text('created-pr');
  for (const part of ['head=claude/1-fixture', 'base=main', 'draft=true', 'Closes #1\nAgent: claude, Session: S1\n']) assert.ok(created.includes(part), part);
  assert.equal(git(checkout, 'rev-list', '--count', 'origin/main..origin/claude/1-fixture'), '1');
  assert.equal(git(checkout, 'rev-parse', '--abbrev-ref', 'claude/1-fixture@{upstream}'), 'origin/claude/1-fixture', 'the upstream is the branch itself, never the base (#646)');
});

for (const [setup, expected] of [[undefined, ''], ['echo "setup on $BRANCH" > setup-ran', 'setup on claude/1-fixture']]) {
  test(`start ${setup ? 'runs the setup command of the project' : 'without setup adds no step'} (#567)`, t => {
    const { run, writeIssue, file, text } = startFixture(t);
    writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...JSON.parse(text('.github/workflow-project.json')), setup }));
    writeIssue(issue('Ready'));
    const result = run('start', '1', '--session', 'S1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(text('setup-ran').trim(), expected);
  });
}

test('start branches from origin/<base> of the Zielrelease and refuses an empty field without a write (#657)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const project = JSON.parse(text('.github/workflow-project.json'));
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...project, baseBranch: { field: 'Zielrelease', pattern: 'release/{value}' } }));
  const withField = base => ({ ...issue('Ready'), projectItems: { nodes: [{ ...issue().projectItems.nodes[0], base }] } });

  writeIssue(withField(undefined));
  let result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Zielrelease of #1 is empty/);
  for (const written of ['stored', 'comment-writes']) assert.equal(existsSync(file(written)), false, written);

  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'release only');
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/release/0.1.2');
  git(checkout, 'reset', '-q', '--hard', 'HEAD~1');
  writeIssue(withField({ name: '0.1.2' }));
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture', 'the checkout stood on main');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'origin/release/0.1.2'));
});

test('start with a failing setup ends with an error and shows its output, claim and PR stay (#567)', t => {
  const { run, writeIssue, file, text } = startFixture(t);
  const project = JSON.parse(text('.github/workflow-project.json'));
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...project, setup: 'echo "vitest fehlt"; exit 3' }));
  writeIssue(issue('Ready'));

  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /vitest fehlt/);
  assert.match(result.stdout, /setup failed/);
  assert.equal(text('stored'), 'In progress');
  assert.ok(existsSync(file('comment-writes')), 'the claim comment exists');
});

test('start takes over a fresh PR of another session only with --takeover', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  const body = 'Closes #1\nAgent: claude, Session: OLD\nMehr';
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body }));
  writeIssue({ ...issue('In progress'), updatedAt: new Date().toISOString(), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body, updatedAt: new Date().toISOString(), headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });

  let result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(text('pr.json')).body, body, 'without --takeover the claim stays');
  result = run('start', '1', '--session', 'S2', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(text('pr.json')).body, body.replace('OLD', 'S2'));
});

test('start --takeover continues the PR branch of another agent, whatever its prefix (#560)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const body = 'Closes #1\nAgent: codex, Session: OLD\nMehr';
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/codex/1-fixture');
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body }));
  writeIssue({ ...issue('In progress'), updatedAt: new Date().toISOString(), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body, updatedAt: new Date().toISOString(), headRefName: 'codex/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });

  const result = run('start', '1', '--session', 'S2', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), 'codex/1-fixture');
  assert.equal(existsSync(file('develops')), false, 'no branch of its own');
});

test('start --takeover finds a PR that only says "Refs #N" and writes the claim line itself (#649)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const body = 'Refs #1\nMehr';
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body, headRefName: 'claude/1-fixture' }));
  writeFileSync(file('open-prs.json'), JSON.stringify([{ number: 7, body, updated_at: new Date().toISOString(), head: { ref: 'claude/1-fixture' } }]));
  writeFileSync(file('branches.json'), JSON.stringify(['claude/1-fixture']));
  writeIssue({ ...issue('In progress'), updatedAt: new Date().toISOString(), branches: [{ name: 'claude/1-fixture' }] });

  const result = run('start', '1', '--session', 'S2', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(JSON.parse(text('pr.json')).body, `${body}\nAgent: claude, Session: S2\n`);
});

test('start --takeover without an open PR stops before it writes anything and names a merged PR (#564)', t => {
  const { run, writeIssue, file } = startFixture(t);
  writeIssue({ ...issue('Ready'), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'MERGED', repository: { nameWithOwner: 'test/example' } }] } });

  const result = run('start', '1', '--session', 'S2', '--takeover');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /--takeover: no open PR closes #1 \(PR #7 is already merged\)/);
  for (const written of ['develops', 'comment-writes', 'created-pr', 'stored']) assert.equal(existsSync(file(written)), false, written);
});

test('start stops for a foreign assignee before it writes anything and names them; --takeover goes on (#572)', t => {
  const { run, writeIssue, file, text } = startFixture(t);
  writeIssue({ ...issue('Ready'), assignees: { nodes: [{ login: 'benni' }] } });
  const written = ['develops', 'comment-writes', 'created-pr', 'stored'];

  let result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /assigned to benni; pass --takeover to take it over/);
  for (const name of written) assert.equal(existsSync(file(name)), false, name);
  assert.equal(JSON.parse(text('issue.json')).assignees.nodes[0].login, 'benni', 'the assignment is untouched');

  result = run('start', '1', '--session', 'S1', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('stored'), 'In progress');
});

test('start stops without a write when someone is assigned between the check and the first write (#572)', t => {
  const { run, writeIssue, file, text } = startFixture(t);
  writeIssue(issue('Ready'));
  // The fake gh swaps the issue file after the first read: the second read sees the claim.
  writeFileSync(file('issue-next.json'), JSON.stringify({ ...issue('Ready'), assignees: { nodes: [{ login: 'benni' }] } }));

  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /assigned to benni.*nothing was written/);
  for (const name of ['develops', 'comment-writes', 'created-pr', 'stored']) assert.equal(existsSync(file(name)), false, name);
  assert.equal(JSON.parse(text('issue.json')).assignees.nodes[0].login, 'benni', 'the assignment is untouched');
});

test('start names the worktree that holds its claimed branch when it cannot switch to it', t => {
  const { checkout, run, writeIssue, git } = startFixture(t);
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  // The predecessor's worktree still has the branch checked out.
  const other = join(dirname(checkout), 'predecessor');
  git(checkout, 'worktree', 'add', '-q', '--track', '-b', 'claude/1-fixture', other, 'origin/claude/1-fixture');
  writeIssue({ ...issue('Ready'), closedByPullRequestsReferences: { totalCount: 1, nodes: [{
    number: 7, state: 'OPEN', body: 'Closes #1\nAgent: claude, Session: S1\n',
    headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' },
  }] } });
  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(result.stderr.replaceAll('\\', '/').includes(other.replaceAll('\\', '/')), result.stderr);
});

test('start --takeover switches to a branch another worktree holds and catches up with origin', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const body = 'Closes #1\nAgent: claude, Session: OLD\nMehr';
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body }));
  writeIssue({ ...issue('In progress'), updatedAt: new Date().toISOString(), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body, updatedAt: new Date().toISOString(), headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });
  git(checkout, 'worktree', 'add', '-q', '--track', '-b', 'claude/1-fixture', join(dirname(checkout), 'predecessor'), 'origin/claude/1-fixture');
  // The predecessor pushed from another clone: the local branch is behind origin.
  const ahead = git(checkout, 'commit-tree', '-p', 'main', '-m', 'ahead', 'main^{tree}');
  git(checkout, 'push', '-q', 'origin', `${ahead}:refs/heads/claude/1-fixture`);
  git(checkout, 'fetch', '-q', 'origin');

  const result = run('start', '1', '--session', 'S2', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), ahead);
});
