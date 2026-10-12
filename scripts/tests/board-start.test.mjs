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
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  const origin = join(dirname(checkout), 'origin.git');
  git(dirname(checkout), 'init', '-q', '--bare', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  // start commits too, so the identity lives in the checkout (a CI runner has none).
  git(checkout, 'config', 'user.name', 't');
  git(checkout, 'config', 'user.email', 't@t');
  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'origin', origin);
  // The branch `gh issue develop` makes on GitHub.
  git(checkout, 'push', '-q', 'origin', 'main', 'main:refs/heads/claude/1-fixture');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: true, linkPages: [[]], url: 'https://github.com/test/example/pull/7' })));
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
  writeFileSync(file('backlink-comments-1.json'), '[]');
  return { checkout, run, writeIssue, git, file, text, env };
}

test('start takes a Ready issue to a Draft PR that closes it, and the same call resumes', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);

  // A blocked issue is refused by the check, before anything is written.
  writeIssue(issue('Ready', [predecessor('OPEN', null)]));
  let result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const written of ['develops', 'comment-writes', 'created-pr', 'stored']) assert.equal(existsSync(file(written)), false, written);

  writeIssue(issue('Ready'));
  // A change the driver staged before the start is theirs: the first commit of start does not take it.
  writeFileSync(file('staged.txt'), 'x');
  git(checkout, 'add', 'staged.txt');
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'diff', '--cached', '--name-only'), 'staged.txt', 'still staged');
  assert.equal(git(checkout, 'ls-tree', '-r', '--name-only', 'origin/claude/1-fixture'), '', 'not in the pushed commit');
  assert.match(result.stdout, /^START #1 session S1 branch claude\/1-fixture base main PR #7$/m);
  assert.equal(text('stored'), 'In progress');
  assert.equal(JSON.parse(text('issue.json')).assignees.nodes[0].login, 'worker');
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(git(checkout, 'rev-list', '--count', 'origin/main..origin/claude/1-fixture'), '1', 'the branch is pushed with its first commit');
  const created = text('created-pr');
  for (const part of ['head=claude/1-fixture', 'base=main', 'draft=true', 'Closes #1\nAgent: claude, Session: S1\n']) assert.ok(created.includes(part), part);
  assert.doesNotMatch(text('backlink-comments-1.json'), /Agent:/, 'the PR is the claim: no claim comment');
  assert.deepEqual(JSON.parse(text('pr.json')).linkPages, [['I1']], 'the issue is linked natively');

  // The same call again: the issue now has its PR, claim and branch, so nothing is created twice.
  rmSync(file('created-pr'));
  const developed = text('develops'), comments = JSON.parse(text('backlink-comments-1.json')).length;
  const openPr = body => writeIssue({ ...JSON.parse(text('issue.json')), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body, headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });
  openPr('Closes #1\nAgent: claude, Session: S1\n');
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^START #1 .* PR #7$/m);
  assert.equal(existsSync(file('created-pr')), false, 'no second PR');
  assert.equal(text('develops'), developed, 'no second branch');
  assert.equal(JSON.parse(text('backlink-comments-1.json')).length, comments, 'no backlink twice');
  assert.equal(JSON.parse(text('pr.json')).body, undefined, 'the own PR body is not touched');

  // A stale PR of another session is taken over: its claim line now names the new session, the rest of the body stays.
  const hoursAgo = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body: 'Closes #1\nAgent: claude, Session: OLD\nMehr' }));
  writeIssue({ ...JSON.parse(text('issue.json')), updatedAt: hoursAgo(9), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body: 'Closes #1\nAgent: claude, Session: OLD\nMehr', updatedAt: hoursAgo(9), headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });
  result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(text('pr.json')).body, 'Closes #1\nAgent: claude, Session: S2\nMehr');
});

test('start leaves a closed foreign Codex session branch untouched (#588)', t => {
  const { checkout, run, writeIssue, git, file, text, env } = startFixture(t);
  env.CODEX_THREAD_ID = 'S2';
  const oldBranch = 'codex/1-fixture', newBranch = 'codex/1-fixture-S2';
  // The fake gh records develop; its GitHub-created branch must exist in the local bare origin.
  git(checkout, 'push', '-q', 'origin', `main:refs/heads/${oldBranch}`, `main:refs/heads/${newBranch}`);
  const oldHead = git(checkout, 'ls-remote', 'origin', `refs/heads/${oldBranch}`);
  writeFileSync(file('branches.json'), JSON.stringify([oldBranch]));
  writeFileSync(file('branch-work.json'), JSON.stringify({ [oldBranch]: { ahead: 0 } }));
  writeIssue({ ...issue('Ready'), closedByPullRequestsReferences: { totalCount: 1, nodes: [{
    number: 6, state: 'CLOSED', body: 'Closes #1\nAgent: codex, Session: S1\n',
    headRefName: oldBranch, repository: { nameWithOwner: 'test/example' },
  }] } });

  const result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), newBranch);
  assert.equal(git(checkout, 'ls-remote', 'origin', `refs/heads/${oldBranch}`), oldHead);
  assert.equal(git(checkout, 'rev-list', '--count', `origin/main..origin/${newBranch}`), '1');
  assert.match(text('develops'), /--name codex\/1-fixture-S2 --base main/);
  assert.ok(text('created-pr').includes('Agent: codex, Session: S2\n'));
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
  assert.ok(text('created-pr').includes('draft=true'), 'the Draft PR exists');
});

test('start takes over a fresh PR of another session only with --takeover', t => {
  const { run, writeIssue, file, text } = startFixture(t);
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

test('start names the worktree that holds the branch when it cannot switch to it', t => {
  const { checkout, run, writeIssue, git } = startFixture(t);
  // The predecessor's worktree still has the branch checked out.
  const other = join(dirname(checkout), 'predecessor');
  git(checkout, 'worktree', 'add', '-q', '--track', '-b', 'claude/1-fixture', other, 'origin/claude/1-fixture');
  writeIssue(issue('Ready'));
  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.ok(result.stderr.replaceAll('\\', '/').includes(other.replaceAll('\\', '/')), result.stderr);
});

test('start --takeover switches to a branch another worktree holds and catches up with origin', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const body = 'Closes #1\nAgent: claude, Session: OLD\nMehr';
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
