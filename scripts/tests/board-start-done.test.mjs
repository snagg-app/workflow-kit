import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';
import { startFixture } from './board-start-fixture.mjs';

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

test('done opens the PR on the base the branch stands on when the Zielrelease changed after the claim (#855)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const project = JSON.parse(text('.github/workflow-project.json'));
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...project, baseBranch: { field: 'Zielrelease', pattern: 'release/{value}', values: { main: 'main' } } }));
  writeIssue({ ...issue('Ready'), projectItems: { nodes: [{ ...issue().projectItems.nodes[0], base: { name: '0.1.2' } }] } });
  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'release only');
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/release/0.1.2');
  git(checkout, 'reset', '-q', '--hard', 'HEAD~1');
  assert.equal(run('start', '1', '--session', 'S1').status, 0);
  // The field now says main and the branch was rebuilt on origin/main; the claim comment still names the release.
  writeIssue({ ...JSON.parse(text('issue.json')), projectItems: { nodes: [{ ...issue().projectItems.nodes[0], base: { name: 'main' } }] },
    comments: { nodes: [{ createdAt: new Date().toISOString(), url: 'u', body: 'Beansprucht.\nAgent: claude, Session: S1\nBasis: release/0.1.2\n' }] } });
  git(checkout, 'reset', '-q', '--hard', 'origin/main');
  writeFileSync(file('work.txt'), 'x');
  git(checkout, 'add', 'work.txt');
  git(checkout, 'commit', '-q', '-m', 'work');
  const result = run('done', '1');
  assert.ok(existsSync(file('created-pr')), result.stdout + result.stderr);
  assert.ok(text('created-pr').includes('base=main'));
});

// #725: on a release base the closing keyword links nothing, so a PR that exists but is not linked yet looks like "no PR": done must reuse it, not fail with 422.
for (const [name, existing] of [['opens the PR on a release base', false], ['reuses the open PR of its branch instead of failing with 422', true]]) {
  test(`done without a PR number ${name} (#725)`, t => {
    const { checkout, run, writeIssue, git, file, text } = startFixture(t);
    writeIssue(issue('Ready'));
    assert.equal(run('start', '1', '--session', 'S1').status, 0);
    git(checkout, 'push', '-q', 'origin', 'main:refs/heads/release/0.1.2');
    git(checkout, 'fetch', '-q', 'origin');
    writeIssue({ ...JSON.parse(text('issue.json')), comments: { nodes: [{ createdAt: new Date().toISOString(), url: 'u', body: 'Beansprucht.\nAgent: claude, Session: S1\nBasis: release/0.1.2\n' }] } });
    writeFileSync(file('work.txt'), 'x');
    git(checkout, 'add', 'work.txt');
    git(checkout, 'commit', '-q', '-m', 'work');
    if (existing) {
      writeFileSync(file('pr-exists'), '');
      writeFileSync(file('head-prs.json'), JSON.stringify([{ number: 7, head: { ref: 'claude/1-fixture' }, base: { ref: 'release/0.1.2' } }]));
    }
    const result = run('done', '1');
    assert.doesNotMatch(result.stdout + result.stderr, /422|Validation Failed/);
    assert.equal(existsSync(file('created-pr')), !existing);
    if (!existing) assert.ok(text('created-pr').includes('base=release/0.1.2'));
    assert.equal(git(checkout, 'rev-list', '--count', 'origin/release/0.1.2..origin/claude/1-fixture'), '1');
  });
}

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

// #938: start installs the dependencies itself when the project has a setup, so the "node_modules fehlt, nichts installiert" hint would be wrong there.
for (const [setup, hinted] of [['echo ran > setup-ran', false], [undefined, true]]) {
  test(`start ${setup ? 'with a setup shows no node_modules hint' : 'without setup keeps the node_modules hint'} (#938)`, t => {
    const { run, writeIssue, file, text } = startFixture(t);
    writeFileSync(file('package.json'), JSON.stringify({ name: 'fixture', dependencies: { left: '1.0.0' } }));
    writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...JSON.parse(text('.github/workflow-project.json')), setup }));
    writeIssue(issue('Ready'));
    const result = run('start', '1', '--session', 'S1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(/node_modules fehlt/.test(result.stdout + result.stderr), hinted, result.stdout + result.stderr);
    assert.equal(existsSync(file('setup-ran')), Boolean(setup));
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

test('start --base branches from that branch and names it as the base, whatever the Zielrelease says (#1039)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const project = JSON.parse(text('.github/workflow-project.json'));
  writeFileSync(file('.github/workflow-project.json'), JSON.stringify({ ...project, baseBranch: { field: 'Zielrelease', pattern: 'release/{value}' } }));
  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'release only');
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/release/0.1.2');
  git(checkout, 'reset', '-q', '--hard', 'HEAD~1');
  writeIssue({ ...issue('Ready'), projectItems: { nodes: [{ ...issue().projectItems.nodes[0], base: { name: '0.1.2' } }] } });

  const result = run('start', '1', '--session', 'S1', '--base', 'main');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^START #1 session S1 branch claude\/1-fixture base main /m);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'origin/main'));
  assert.notEqual(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'origin/release/0.1.2'));
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

test('start --takeover continues a pushed branch without a PR and claims it for the new session (#655)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  const ahead = git(checkout, 'commit-tree', '-p', 'main', '-m', 'ahead', 'main^{tree}');
  git(checkout, 'push', '-q', 'origin', `${ahead}:refs/heads/claude/1-fixture`);
  writeFileSync(file('branches.json'), JSON.stringify(['claude/1-fixture']));
  const claim = { createdAt: new Date().toISOString(), url: 'u', body: 'Beansprucht.\nAgent: claude, Session: OLD\nBasis: main\n' };
  writeIssue({ ...issue('In progress'), updatedAt: new Date().toISOString(), comments: { nodes: [claim] }, branches: [{ name: 'claude/1-fixture' }] });
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, ...claim }]));

  let result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  result = run('start', '1', '--session', 'S2', '--takeover');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), ahead);
  assert.match(JSON.parse(text('backlink-comments-1.json')).at(-1).body, /Session: S2\n/);
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

test('start of the own session continues the pushed branch of the issue instead of branching anew (#995)', t => {
  const { checkout, run, writeIssue, git, file } = startFixture(t);
  const ahead = git(checkout, 'commit-tree', '-p', 'main', '-m', 'ahead', 'main^{tree}');
  git(checkout, 'push', '-q', 'origin', `${ahead}:refs/heads/claude/1-fixture`);
  writeFileSync(file('branches.json'), JSON.stringify(['claude/1-fixture']));
  const claim = { createdAt: new Date().toISOString(), url: 'u', body: 'Beansprucht.\nAgent: claude, Session: S2\nBasis: main\n' };
  writeIssue({ ...issue('In progress'), updatedAt: new Date().toISOString(), comments: { nodes: [claim] }, branches: [{ name: 'claude/1-fixture' }] });
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, ...claim }]));
  const result = run('start', '1', '--session', 'S2');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'branch', '--show-current'), 'claude/1-fixture');
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), ahead);
});
