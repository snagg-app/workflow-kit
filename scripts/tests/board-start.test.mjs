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

test('start --issue-repo takes the issue of the other repository and opens the PR here, closing it by its full name', t => {
  const { run, writeIssue, git, checkout, file, text } = startFixture(t);
  writeIssue(issue('Ready'));
  const result = run('--issue-repo', 'test/kit', 'start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^test\/kit#1 Fixture$/m);
  const asked = text('repositories').split('\n');
  assert.ok(asked.includes('issue owner=test/name=kit') && !asked.includes('issue owner=test/name=example'), 'the issue is looked up in the other repository only');
  assert.ok(text('created-pr').includes('Closes test/kit#1\nAgent: claude, Session: S1\n'));
  assert.equal(existsSync(file('develops')), false, 'no linked branch in the other repository');
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(run('--issue-repo', 'test/kit', 'check', '1').status, 2, 'only start and done take the option');
});

test('start resumes its empty ordinary upper claim before linking a native stack (#606)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  git(checkout, 'switch', '-q', '-c', 'lower');
  writeFileSync(file('lower.txt'), 'lower source');
  git(checkout, 'add', 'lower.txt');
  git(checkout, 'commit', '-q', '-m', 'lower source');
  git(checkout, 'push', '-q', 'origin', 'lower');
  const lowerHead = git(checkout, 'rev-parse', 'HEAD');
  git(checkout, 'switch', '-q', 'main');
  const lower = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false,
    repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'lower', headRefOid: lowerHead };
  const blocked = predecessor('OPEN', null, [lower], { repository: { nameWithOwner: 'test/example' } });
  writeIssue(issue('Ready', [blocked]));
  let result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'diff', '--name-only', 'origin/lower', 'HEAD'), '', 'empty claim, no placeholder source diff');
  assert.equal(text('stacks.json'), '', 'the empty claim is not added to a native stack');
  const developed = text('develops'), created = text('created-pr');
  const current = { number: 7, state: 'OPEN', body: 'Closes #1\nAgent: claude, Session: S1\n',
    headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } };
  writeIssue({ ...JSON.parse(text('issue.json')), closedByPullRequestsReferences: { totalCount: 1, nodes: [current] } });
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(text('created-pr'), created, 'resume keeps the same claim');
  assert.equal(text('develops'), developed, 'resume keeps the same branch');
  assert.equal(text('stored'), 'In progress');

  // A different session still cannot use the unlinked claim; no stack fallback weakens ownership.
  result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(text('created-pr'), created);
  assert.equal(text('develops'), developed);
});

for (const retained of ['remote', 'local', 'other repository']) test(`start leaves a closed foreign Codex session ${retained} branch untouched (#588)`, t => {
  const { checkout, run, writeIssue, git, file, text, env } = startFixture(t);
  env.CODEX_THREAD_ID = 'S2';
  const oldBranch = 'codex/1-fixture', newBranch = 'codex/1-fixture-S2';
  if (retained !== 'local') git(checkout, 'push', '-q', 'origin', `main:refs/heads/${oldBranch}`);
  else {
    const foreign = git(checkout, 'commit-tree', '-p', 'main', '-m', 'S1 work', 'main^{tree}');
    git(checkout, 'update-ref', `refs/heads/${oldBranch}`, foreign);
  }
  const oldHead = git(checkout, 'ls-remote', 'origin', `refs/heads/${oldBranch}`);
  const localHead = retained === 'local' ? git(checkout, 'rev-parse', `refs/heads/${oldBranch}`) : null;
  // Omitted by the bounded GraphQL list: the exact remote ref must still hold this name.
  writeFileSync(file('branches.json'), '[]');
  writeFileSync(file('branch-work.json'), JSON.stringify({ [oldBranch]: { ahead: 0 } }));
  const linked = [{
    number: 6, state: 'CLOSED', body: 'Closes #1\nAgent: codex, Session: S1\n',
    headRefName: oldBranch, repository: { nameWithOwner: 'test/example' },
  }];
  if (retained === 'other repository') linked.push({
    number: 8, state: 'OPEN', body: 'Agent: codex, Session: S2\n',
    headRefName: oldBranch, repository: { nameWithOwner: 'test/other' },
  });
  writeIssue({ ...issue('Ready'), closedByPullRequestsReferences: { totalCount: linked.length, nodes: linked } });

  const result = run('start', '1', '--session', 'S2');
  if (retained === 'other repository') {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /test\/other#8/);
    assert.equal(git(checkout, 'ls-remote', 'origin', `refs/heads/${oldBranch}`), oldHead);
    for (const name of ['develops', 'created-pr', 'stored']) assert.equal(existsSync(file(name)), false, name);
    return;
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), newBranch);
  assert.equal(git(checkout, 'ls-remote', 'origin', `refs/heads/${oldBranch}`), oldHead);
  if (localHead) assert.equal(git(checkout, 'rev-parse', `refs/heads/${oldBranch}`), localHead);
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
