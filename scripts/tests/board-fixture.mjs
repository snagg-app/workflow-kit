import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodeTest from 'node:test';
import { runBoard } from './board-runner.mjs';

// Helpers of the board tests. One test file per board.mjs command (board-<command>.test.mjs; large commands have a second
// file), so drivers who add tests for different commands touch different files; node:test runs the files side by side.
// board.mjs runs in a worker thread with a fake gh (board-runner.mjs, board-worker.mjs, fake-gh.mjs), not as a process per call.
const CALL_TIMEOUT_MS = 60_000;
// The start line names the running test: a hung file shows its last "start" instead of staying silent (node:test prints a test only when it ends).
export const test = (name, body) => nodeTest(name, t => { console.error(`start: ${name}`); return body(t); });

export const handoffComment = changes => ({ id: 900, user: { login: 'worker', type: 'User' }, body: '## Übergabe\n\nHead: abcdef1\n\n### Retro\n\n- Keine Funde',
  html_url: 'h', created_at: '2999-01-01T00:00:00Z', updated_at: '2999-01-01T00:00:00Z', ...changes });

/** Isolated checkout with paginated GitHub responses and a record of every mutation. */
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-board-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), bin = join(root, 'bin');
  mkdirSync(join(checkout, '.github'), { recursive: true });
  mkdirSync(join(checkout, '.git')); // board.mjs takes the nearest checkout as its project
  mkdirSync(bin);
  // board.mjs only looks for a `gh` (and `ready --local` for a `git`) on PATH outside the checkout; its gh calls go to fake-gh.mjs (see board-worker.mjs).
  for (const tool of ['gh', 'git']) writeFileSync(join(bin, process.platform === 'win32' ? `${tool}.exe` : tool), '');
  writeFileSync(join(checkout, '.github/workflow-project.json'), JSON.stringify({ repository: 'test/example', id: 'P1', language: 'de' }));
  // By default the driver has posted the handoff comment long after any push; tests about it replace this file.
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([handoffComment()]));
  // The session variables of the running agent must not reach board.mjs; a test names its own session.
  const env = { CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', BOARD_FIELD_CACHE: '0', BOARD_TRACE: '', SONAR_TOKEN: '' }; // no token of the developer's own environment: the Sonar count comes from the fake check summary
  const board = {
    checkout, env,
    // A call that hangs (a `wait` that never ends) would block the whole file silently: it is cut off and named with its test.
    run: (...args) => {
      const result = runBoard({ cwd: checkout, env: { ...process.env, PATH: bin, ...env }, args, timeout: CALL_TIMEOUT_MS });
      assert.ok(!result.timedOut, `"${t.name}": board.mjs ${args.join(' ')} did not finish in ${CALL_TIMEOUT_MS / 1000} s`);
      return result;
    },
    // What board.mjs printed in the first `ms` milliseconds, for a command that waits on purpose.
    runBriefly: (ms, ...args) => runBoard({ cwd: checkout, env: { ...process.env, PATH: bin, ...env }, args, timeout: ms }).stdout,
    writeIssue: issue => writeFileSync(join(checkout, 'issue.json'), JSON.stringify(issue)),
    // The GraphQL queries the fake gh received since the last call of this, oldest first (GitHub charges a query by what it asks for).
    queries: () => {
      const file = join(checkout, 'queries'), sent = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      rmSync(file, { force: true });
      return sent;
    },
    // An unknown flag, long or short, or a word the command does not take ends in the usage line before gh is called:
    // every gh call leaves a file in the checkout, so none may appear. `field` takes any number of pairs, so it only uses the flags.
    refusesUnknownFlag: (...args) => {
      for (const extra of args[0] === 'field' ? ['--oops', '-x'] : ['--oops', '-x', 'extra']) {
        const before = readdirSync(checkout).sort();
        const result = board.run(...args, extra);
        assert.equal(result.status, 2, `${args[0]} ${extra}: ${result.stdout}${result.stderr}`);
        assert.deepEqual(readdirSync(checkout).sort(), before, `${args[0]} ${extra} reached gh`);
      }
    },
  };
  return board;
}

export function handoffFixture(t) {
  const context = fixture(t), writeIssue = context.writeIssue;
  context.writeIssue = issue => writeIssue(issue.closedByPullRequestsReferences?.totalCount === 0
    ? { ...issue, closedByPullRequestsReferences: { totalCount: 1, nodes: [
      { number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/example' } },
    ] } }
    : issue);
  return context;
}

export const issue = (status = 'Ready', nodes = [], totalCount = nodes.length) => ({
  id: 'I1', number: 1, title: 'Fixture', state: 'OPEN', assignees: { nodes: [] },
  projectItems: { nodes: [{ id: 'PI1', project: { id: 'P1' }, status: { name: status } }] },
  closedByPullRequestsReferences: { totalCount: 0, nodes: [] },
  blockedBy: { totalCount, nodes }, subIssues: { totalCount: 0, nodes: [] },
});
// prs: the PRs GitHub lists as closing the predecessor (closedByPullRequestsReferences).
export const predecessor = (state, stateReason, prs = [], changes) => ({ number: 9, state, stateReason, repository: { nameWithOwner: 'test/other' },
  closedByPullRequestsReferences: { totalCount: prs.length, nodes: prs }, ...changes });

// Pushed long enough ago that the reviewer grace has passed.
export const pushedAt = () => new Date(Date.now() - 10 * 60_000).toISOString();
export const handoffPr = changes => ({
  number: 7, state: 'OPEN', isDraft: false, baseRefName: 'release/0.1.1', headRefOid: 'abcdef1234',
  mergeStateStatus: 'CLEAN', reviewDecision: null,
  latestOpinionatedReviews: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: pushedAt(),
    checkSuites: { totalCount: 1, nodes: [{ createdAt: pushedAt(), status: 'COMPLETED', conclusion: 'SUCCESS', app: { slug: 'github-actions' }, checkRuns: { totalCount: 1 } }] },
    statusCheckRollup: { contexts: { totalCount: 1, nodes: [
      { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] } } } }] },
  reviewRequests: { totalCount: 0, nodes: [] }, requestEvents: { totalCount: 0, nodes: [] },
  linkPages: [['I1']], ...changes,
});

/** What the reviews tests share: a checkout, PR snapshots, Codex traces and `look` (write the snapshot, run `reviews`). */
export function reviewsFixture(t) {
  const { checkout, run, runBriefly, queries } = fixture(t);
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const codexUser = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
  const check = (status, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null) => ({ __typename: 'CheckRun', name: 'CI', status, conclusion });
  const suite = (status = 'COMPLETED', runs = 1, minutes = 1, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null, run, workflowId = 'W-Frontend', slug = 'github-actions') => ({
    createdAt: minutesAgo(minutes), status, conclusion, app: { slug }, checkRuns: { totalCount: runs },
    workflowRun: run === undefined ? null : { databaseId: run, workflow: { id: workflowId } } });
  const pr = ({ pushed = 5, contexts = [check('COMPLETED')], total = contexts.length, requests = [], requestedAgo, requestEventTotal, threadPages,
    suites = [suite('COMPLETED', 1, pushed)], suiteTotal = suites.length } = {}) => ({
    number: 7, state: 'OPEN', isDraft: false, baseRefName: 'release/0.1.1', headRefOid: 'abcdef1234', mergeStateStatus: 'CLEAN', reviewDecision: null,
    latestOpinionatedReviews: { totalCount: 0, nodes: [] },
    commits: { nodes: [{ commit: { oid: 'abcdef1234', committedDate: minutesAgo(pushed + 5),
      checkSuites: { totalCount: suiteTotal, nodes: suites }, statusCheckRollup: { contexts: { totalCount: total, nodes: contexts } } } }] },
    reviewRequests: { totalCount: requests.length, nodes: requests.map(login => ({ requestedReviewer: { login } })) },
    requestEvents: { totalCount: requestEventTotal ?? (requestedAgo === undefined ? 0 : requests.length),
      nodes: requestedAgo === undefined ? [] : requests.map(login => ({ createdAt: minutesAgo(requestedAgo), requestedReviewer: { login } })) },
    threadPages,
  });
  let commentId = 0;
  const codex = (row, minutes) => ({ id: ++commentId, user: codexUser, html_url: 'u', created_at: minutesAgo(minutes), updated_at: minutesAgo(minutes),
    body: `| Review | Status | Commit |\n| Code Review | ${row} <relative-time datetime="${minutesAgo(minutes)}"></relative-time> | \`abcdef1\` |` });
  const reaction = (content, minutes) => ({ content, created_at: minutesAgo(minutes), user: codexUser });
  const look = (data, { comments = [], reactions = [], inline = [], commentReactions = [], reviewList = [] } = {}, ...options) => {
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(data));
    writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify(comments));
    writeFileSync(join(checkout, 'issues-reactions.json'), JSON.stringify(reactions));
    writeFileSync(join(checkout, 'pulls-comments.json'), JSON.stringify(inline));
    writeFileSync(join(checkout, 'comments-reactions.json'), JSON.stringify(commentReactions));
    writeFileSync(join(checkout, 'pulls-reviews.json'), JSON.stringify(reviewList));
    return run('reviews', '7', ...options);
  };
  const reviews = (...args) => look(...args).status;

  // Draft then Ready starts a second run of the same job and cancels the first: only the newest run of a job counts.
  // `run` is the workflow run the job belongs to; by default every job is the only one of its own run.
  const job = (run, status, conclusion = status === 'COMPLETED' ? 'SUCCESS' : null, name = 'Backend', workflow = 'Backend importer', workflowId = `W-${workflow}`) =>
    ({ ...check(status, conclusion), name, checkSuite: { databaseId: run * 10, app: { slug: 'github-actions' }, workflowRun: { databaseId: run, workflow: { id: workflowId, name: workflow } } } });
  // Ready since 5 minutes: a pull_request run created before that was a Draft run, and its skipped job guard proves nothing.
  const draftRun = (run, conclusion = 'SKIPPED', { minutes = 10, event = 'pull_request', time, ...names } = {}) => {
    const base = job(run, conclusion === 'IN_PROGRESS' ? conclusion : 'COMPLETED', conclusion === 'IN_PROGRESS' ? null : conclusion, names.name, names.workflow);
    return { ...base, checkSuite: { ...base.checkSuite, createdAt: time ?? minutesAgo(minutes), workflowRun: { ...base.checkSuite.workflowRun, event } } };
  };
  const readyHead = (contexts, extra) => ({ ...pr({ contexts, pushed: 10 }), isDraft: false, createdAt: minutesAgo(30), readyEvents: { nodes: [{ createdAt: minutesAgo(5) }] }, ...extra });
  const oldTraces = { comments: [codex('Completed', 0)] };
  return { checkout, run, runBriefly, queries, minutesAgo, job, draftRun, readyHead, oldTraces, codexUser, check, suite, pr, codex, reaction, look, reviews };
}
