// The facts of one PR head, read from GitHub and Sonar: checks, comments, threads, reactions, pushes, the Sonar count.
// `readFacts` returns a plain object for judgeReview (review-verdict.mjs). Fields that cost a request are read on first use and then kept,
// so a red head never reads what only a green one needs, and an unreadable field fails where the verdict needs it, not before.
import assert from 'node:assert/strict';
import { headPushed } from './review-verdict.mjs';
import { sonarIssues } from './sonar.mjs';
import { env, graphql, name, number, owner, project, rest, restAll } from './board-context.mjs';
import { stackOrderText, prQuery } from './board-common.mjs';
import { conflictLine } from './board-claims.mjs';
import { readStacks } from './board-stack.mjs';

/** Defines each key of `reads` as a field that runs its function on first access. A failed read is not kept: the next access reads again. */
function lazyFields(target, reads) {
  for (const [key, read] of Object.entries(reads)) {
    let done = false, value;
    Object.defineProperty(target, key, { enumerable: true, get() { if (!done) { value = read(); done = true; } return value; } });
  }
  return target;
}

/** Links of unresolved review threads across every page, including findings on earlier heads. */
function unresolvedThreads(prNumber = number, firstPage) {
  const links = [];
  for (let after; ;) {
    const reviewThreads = firstPage ?? graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}
        nodes{isResolved comments(first:1){nodes{url}}}}}}}`,
    { owner, name, number: prNumber, ...(after && { after }) }).repository.pullRequest.reviewThreads;
    firstPage = undefined;
    links.push(...reviewThreads.nodes.filter(thread => !thread.isResolved).map(thread => thread.comments.nodes[0]?.url ?? 'unreadable thread'));
    if (!reviewThreads.pageInfo.hasNextPage) return links;
    assert.ok(reviewThreads.pageInfo.endCursor && reviewThreads.pageInfo.endCursor !== after, 'Thread pagination did not advance');
    after = reviewThreads.pageInfo.endCursor;
  }
}

const readPr = prNumber => {
  for (const suites of [30, 100]) {
    const pr = graphql(prQuery(suites), { owner, name, number: prNumber }).repository.pullRequest;
    const commit = pr?.commits?.nodes?.[0]?.commit;
    if (suites === 100 || !(commit?.checkSuites?.totalCount > commit.checkSuites.nodes.length)) return pr;
  }
};

/** Commits the base gained since the PR's merge-base and the files both sides changed; null while the base has not moved.
 * ponytail: compare lists the first 300 changed files only (GitHub's cap, all on page 1) and renames match by their new name; replace when a miss costs a CI run. */
function baseMovement(pr) {
  assert.ok(pr.baseRefName, 'The PR base is not readable');
  // A branch may contain "#" or "?"; "/" stays a separator. per_page=1 keeps the commit list short, the file list is not paged.
  const ref = pr.baseRefName.split('/').map(encodeURIComponent).join('/');
  const compare = basehead => rest(`repos/${project.repository}/compare/${basehead}?per_page=1`);
  const { behind_by: behind, files: own = [] } = compare(`${ref}...${pr.headRefOid}`);
  assert.ok(Number.isSafeInteger(behind), 'The base comparison is unreadable');
  if (!behind) return null;
  const base = new Set((compare(`${pr.headRefOid}...${ref}`).files ?? []).map(file => file.filename));
  return { behind, shared: own.map(file => file.filename).filter(file => base.has(file)) };
}

/** The facts of `pr` as it is now. `threadsOf` reads the unresolved threads (wait reuses the last answer). */
function readFacts(pr, threadsOf) {
  const base = `repos/${project.repository}`;
  const target = { pr };
  const pushed = () => headPushed(pr);
  const after = time => Date.parse(time) >= pushed();
  return lazyFields(target, {
    pushLog() {
      const log = rest(`${base}/activity?ref=${encodeURIComponent(`refs/heads/${pr.headRefName}`)}&per_page=100`);
      assert.ok(Array.isArray(log), 'Push log is unreadable');
      return log;
    },
    baseMovement: () => baseMovement(pr),
    headRuns() {
      const runs = rest(`${base}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`).workflow_runs;
      assert.ok(Array.isArray(runs), 'The workflow runs of the head are unreadable');
      return runs;
    },
    stackOrderText: () => readStacks(pr.number).length ? stackOrderText : null,
    conflictLine: () => conflictLine(pr),
    comments: () => restAll(`${base}/issues/${pr.number}/comments`),
    // Per Sonar check of the head: the count and findings, or the failure to raise where the verdict reaches that check.
    sonar() {
      const checks = (pr.commits.nodes[0].commit.statusCheckRollup?.contexts.nodes ?? [])
        .filter(check => check.checkSuite?.app?.slug === 'sonarqubecloud' && check.status === 'COMPLETED' && check.conclusion !== 'SKIPPED');
      return new Map(checks.map(check => {
        try { return [check, sonarIssues(check.detailsUrl, pr.number, check.summary, env.SONAR_TOKEN)]; } catch (error) { return [check, { error }]; }
      }));
    },
    reviewList: () => restAll(`${base}/pulls/${pr.number}/reviews`),
    // Bots acknowledge "@bot review" comments with a reaction on that comment, not on the PR.
    reactions: () => [...restAll(`${base}/issues/${pr.number}/reactions`),
      ...target.comments.filter(comment => after(comment.created_at) && /@[\w-]+(\[bot\])?\s+review\b/i.test(comment.body))
        .flatMap(comment => restAll(`${base}/issues/comments/${comment.id}/reactions`))],
    inline: () => restAll(`${base}/pulls/${pr.number}/comments`),
    threads: () => threadsOf(pr),
  });
}

export {  readPr, readFacts, unresolvedThreads, baseMovement  };
