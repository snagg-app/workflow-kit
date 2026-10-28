import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, issue, predecessor, test } from './board-fixture.mjs';
import { startFixture } from './board-start-fixture.mjs';

test('start refuses a spec before assignment or claim writes', t => {
  const { checkout, run, writeIssue } = fixture(t);
  writeIssue({ ...issue('Ready'), labels: { nodes: [{ name: 'spec' }] } });
  const result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /start is refused/);
  assert.deepEqual(JSON.parse(readFileSync(join(checkout, 'issue.json'), 'utf8')).assignees.nodes, []);
  for (const name of ['mutations', 'created-pr', 'develops']) assert.equal(existsSync(join(checkout, name)), false, name);
});

test('start refuses a blocked issue with the reason from its text, and --force starts it (#1056)', t => {
  const { run, writeIssue, file } = startFixture(t);
  writeIssue({ ...issue('Ready'), body: 'Text\n\nVoraussetzung: PR #5302 ist gemergt.', labels: { nodes: [{ name: 'blocked' }] } });
  const refused = run('start', '1', '--session', 'S1');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /label "blocked".*Voraussetzung: PR #5302 ist gemergt/);
  assert.equal(existsSync(file('mutations')), false, 'nothing was written');
  const forced = run('start', '1', '--session', 'S1', '--force');
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
});

test('start lists related work of the last 48 hours as a hint, with one search (#1056)', t => {
  const { run, writeIssue, text, file } = startFixture(t);
  const hour = hours => new Date(Date.now() - hours * 3600000).toISOString();
  writeIssue({ ...issue('Ready'), body: 'Betrifft `backend/importer/RunService.java` und `ImportBatchStep`.' });
  writeFileSync(file('related-search.json'), JSON.stringify([
    { number: 1, title: 'self', state: 'open', updated_at: hour(1) },
    { number: 20, title: 'merged fix', state: 'closed', updated_at: hour(2), pull_request: { merged_at: hour(2) } },
    { number: 21, title: 'abandoned', state: 'closed', updated_at: hour(2), pull_request: { merged_at: null } },
    { number: 22, title: 'old', state: 'open', updated_at: hour(60) },
    { number: 23, title: 'same bug', state: 'open', updated_at: hour(3) }]));
  const result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = result.stdout + result.stderr;
  assert.match(out, /#20 PR merged: merged fix/);
  assert.match(out, /#23 issue open: same bug/);
  assert.doesNotMatch(out, /#21 |#22 |self/);
  assert.equal(text('related-queries').trim().split('\n').length, 1, 'one search');
  assert.match(text('related-queries'), /repo:test\/example updated:>=\d{4}-\d\d-\d\d \("backend\/importer\/RunService\.java" OR "ImportBatchStep"\)/);
});


test('start prints the kit hints of the session hook, so an agent without hooks gets them too (#690)', t => {
  const { checkout, run, writeIssue, file, env } = startFixture(t);
  writeIssue(issue('Ready'));
  // The project uses the kit (hook entry), but the shared kit is missing: the hook would say so at session start.
  mkdirSync(join(checkout, '.claude'));
  writeFileSync(join(checkout, '.claude/settings.json'), '{"hooks":{"SessionStart":[{"hooks":[{"id":"workflow-kit"}]}]}}');
  env.WORKFLOW_KIT_DIR = join(dirname(checkout), 'no-such-kit');
  // #813: a kit that cannot be linked stops start before any write.
  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Workflow-Kit-Checkout .* fehlt oder ist unvollständig/);
  assert.equal(existsSync(file('stored')), false);
});

test('start brings the shared kit to origin/main, and refuses without a write when it cannot (#813)', t => {
  const { checkout, run, writeIssue, git, file, env } = startFixture(t);
  writeIssue(issue('Ready'));
  mkdirSync(join(checkout, '.claude'));
  writeFileSync(join(checkout, '.claude/settings.json'), '{"hooks":{"SessionStart":[{"hooks":[{"id":"workflow-kit"}]}]}}');
  const parent = dirname(checkout), upstream = join(parent, 'kit-upstream'), kit = join(parent, 'kit');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(join(upstream, 'AGENT_RULES.md'), 'x');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', 'kit');
  git(parent, 'clone', '-q', upstream, kit);
  env.WORKFLOW_KIT_DIR = kit;
  // The kit has an own commit: no fast-forward, start stops and changes nothing.
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'newer');
  git(kit, 'commit', '-q', '--allow-empty', '-m', 'mine');
  const mine = git(kit, 'rev-parse', 'HEAD');
  let result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /could not be brought to origin\/main/);
  // #863: the fresh worktree had no link; start made it and said so in one line, even though the update then stopped it.
  assert.match(result.stdout + result.stderr, /linked \.vendor\/workflow-kit to .* \(it was missing in this worktree\)/);
  assert.equal(git(kit, 'rev-parse', 'HEAD'), mine);
  assert.equal(existsSync(file('stored')), false, 'nothing was claimed');
  // Behind origin/main: start fast-forwards the kit first.
  git(kit, 'reset', '-q', '--hard', 'origin/main');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'newest');
  result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(kit, 'rev-parse', 'HEAD'), git(upstream, 'rev-parse', 'HEAD'));
  assert.equal(realpathSync(join(checkout, '.vendor/workflow-kit')), realpathSync(kit));
});

test('the claim comment follows the profile language, and a claim in either language is read (#759)', t => {
  const { checkout, run, writeIssue, text } = startFixture(t);
  writeIssue(issue('Ready'));
  const profile = join(checkout, '.github/workflow-project.json');
  const language = JSON.parse(readFileSync(profile, 'utf8')).language;
  writeFileSync(profile, JSON.stringify({ ...JSON.parse(readFileSync(profile, 'utf8')), language: 'en' }));
  assert.equal(run('start', '1', '--session', 'S1').status, 0);
  const english = JSON.parse(text('backlink-comments-1.json')).map(comment => comment.body).join('');
  assert.match(english, /^Claimed\.\nAgent: claude, Session: S1\nBase: main\n/);
  assert.notEqual(language, 'en', 'the fixture profile stays German, the other tests rely on it');
  // The same session resumes from the English claim: no second claim comment.
  const writes = text('comment-writes');
  writeIssue({ ...JSON.parse(text('issue.json')), comments: { nodes: [{ createdAt: new Date().toISOString(), url: 'u', body: english }] } });
  assert.equal(run('start', '1', '--session', 'S1').status, 0);
  assert.equal(text('comment-writes'), writes);
});

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

test('two sessions start at once: the claim comment written first wins, the other stops and withdraws its comment (#943)', t => {
  const { run, writeIssue, file, text } = startFixture(t);
  writeIssue(issue('Ready'));
  writeFileSync(file('rival-comment'), 'Beansprucht.\nAgent: claude, Session: S2\nBasis: main\n');
  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /session S2 claimed #1 first/);
  assert.equal(text('comment-deletes'), '2\n', 'only the own comment is withdrawn');
  assert.deepEqual(JSON.parse(text('backlink-comments-1.json')).map(comment => comment.id), [1], 'only the winner claim stays');
});

test('a progress comment without a session during start is no rival claim (#1005)', t => {
  const { run, writeIssue, file, text } = startFixture(t);
  writeIssue(issue('Ready'));
  writeFileSync(file('rival-comment'), 'Fortschritt.\nAgent: claude\n');
  const result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(file('comment-deletes')), false, 'the own claim stays');
  assert.match(text('backlink-comments-1.json'), /Session: S1/);
});

test('a claim that REST already lists but the issue query does not yet blocks start (#1005)', t => {
  const { run, writeIssue, file, text } = startFixture(t);
  writeIssue(issue('Ready'));
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, user: { login: 'worker' }, created_at: '2026-10-07T00:00:00Z', body: 'Beansprucht.\nAgent: claude, Session: S2\nBasis: main\n', html_url: 'u' }]));
  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /changed while starting/);
  assert.equal(JSON.parse(text('backlink-comments-1.json')).length, 1, 'nothing was written');
});

test('two sessions take over the same PR at once: the older claim wins, the other writes no PR body (#979)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  const hoursAgo = new Date(Date.now() - 9 * 3_600_000).toISOString();
  const body = 'Closes #1\nAgent: claude, Session: OLD\nMehr';
  writeFileSync(file('pr.json'), JSON.stringify({ ...JSON.parse(text('pr.json')), body }));
  writeIssue({ ...issue('In progress'), updatedAt: hoursAgo, closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 7, state: 'OPEN', body, updatedAt: hoursAgo, headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' } }] } });
  writeFileSync(file('rival-comment'), 'Beansprucht.\nAgent: claude, Session: S3\nBasis: main\n');
  const result = run('start', '1', '--session', 'S2');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /session S3 claimed #1 first/);
  assert.equal(JSON.parse(text('pr.json')).body, body, 'the PR body is untouched');
  assert.deepEqual(JSON.parse(text('backlink-comments-1.json')).map(comment => comment.id), [1], 'only the winner claim stays');
});

test('start that fails on the branch switch leaves the issue unassigned and not In progress (#979)', t => {
  const { checkout, run, writeIssue, git, file, text } = startFixture(t);
  git(checkout, 'push', '-q', 'origin', 'main:refs/heads/claude/1-fixture');
  git(checkout, 'worktree', 'add', '-q', '--track', '-b', 'claude/1-fixture', join(dirname(checkout), 'predecessor'), 'origin/claude/1-fixture');
  writeIssue({ ...issue('Ready'), closedByPullRequestsReferences: { totalCount: 1, nodes: [{
    number: 7, state: 'OPEN', body: 'Closes #1\nAgent: claude, Session: S1\n',
    headRefName: 'claude/1-fixture', repository: { nameWithOwner: 'test/example' },
  }] } });
  const result = run('start', '1', '--session', 'S1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(existsSync(file('stored')), false, 'no status write');
  assert.deepEqual(JSON.parse(text('issue.json')).assignees.nodes, []);
});

test('done takes the session of start, not the variable a subagent inherits (#973)', t => {
  const { checkout, run, writeIssue, git, file, text, env } = startFixture(t);
  writeIssue(issue('Ready'));
  assert.equal(run('start', '1', '--session', 'S1').status, 0);
  const body = 'Beansprucht.\nAgent: claude, Session: S1\nBasis: main\n';
  writeIssue({ ...JSON.parse(text('issue.json')), comments: { nodes: [{ createdAt: new Date().toISOString(), url: 'u', body }] } });
  writeFileSync(file('work.txt'), 'x');
  git(checkout, 'add', 'work.txt');
  git(checkout, 'commit', '-q', '-m', 'work');
  env.CLAUDE_CODE_SESSION_ID = 'PARENT';
  const result = run('done', '1');
  assert.doesNotMatch(result.stdout + result.stderr, /not of this session/);
  assert.equal(existsSync(file('created-pr')), true, result.stdout + result.stderr);
});

test('done opens no first PR with the claim of another session (#943)', t => {
  const { checkout, run, writeIssue, git, file, text, env } = startFixture(t);
  writeIssue(issue('Ready'));
  assert.equal(run('start', '1', '--session', 'S1').status, 0);
  const body = 'Beansprucht.\nAgent: claude, Session: S2\nBasis: main\n';
  writeIssue({ ...JSON.parse(text('issue.json')), comments: { nodes: [{ createdAt: new Date().toISOString(), url: 'u', body }] } });
  writeFileSync(file('work.txt'), 'x');
  git(checkout, 'add', 'work.txt');
  git(checkout, 'commit', '-q', '-m', 'work');
  const result = run('done', '1');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /claim of session S2/);
  assert.equal(existsSync(file('created-pr')), false);
});

test('start sets push.default to simple in the clone, even when the clone had upstream (#3822)', t => {
  const { checkout, run, writeIssue, git } = startFixture(t);
  git(checkout, 'config', 'push.default', 'upstream');
  writeIssue(issue('Ready'));
  const result = run('start', '1', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(checkout, 'config', '--get', 'push.default'), 'simple');
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

