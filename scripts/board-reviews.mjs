// The review gate: one look at a PR head (CI, bots, threads, change requests) and the project settings it reads from the PR's base branch.
// The facts are read in review-facts.mjs and judged in review-verdict.mjs; this factory joins them for `wait`, `handoff`, `done` and `merge`.
// A factory over `env` (project, github adapter, the number and the stack helpers of the caller), so tests and other commands can import it.
import assert from 'node:assert/strict';
import { readProfileAt } from './project-profile.mjs';
import { createReviewFacts } from './review-facts.mjs';
import { filesText, judgeReview, optionalReviewers, reviewerKey } from './review-verdict.mjs';

/** env: { project, owner, name, github, number, graceMinutes(), prQuery(suites), readStacks(pull), stackOrderText, conflictLine(pr) } */
export function createReviews(env) {
  const { project, github } = env;
  const { readPr, readFacts, unresolvedThreads, baseMovement } = createReviewFacts(env);

  // The review gate (`reviews`, so `wait`, `handoff` and `merge`) takes these settings from the target branch of the PR as it is now, never from
  // the checkout: a stale checkout would apply rules the branch has since changed (#448).
  // ponytail: one REST read per look, no cache; cache by base commit if the REST quota ever gets tight.
  let gate = project;
  let optional; // the optionalReviewers set of `gate`, built on first use and dropped with every new `gate`
  function useBaseSettings(pr) {
    assert.ok(pr.baseRefName, 'The PR base is not readable');
    const base = readProfileAt(github.rest, project.repository, pr.baseRefName);
    gate = { ...project, ...Object.fromEntries(['awaitApps', 'optionalReviewers', 'updateBranchChecks', 'doneBaseMerge'].map(key => [key, base[key]])) };
    optional = undefined;
  }
  const isOptional = name => (optional ??= optionalReviewers(gate)).has(reviewerKey(name));

  /** One look at the PR head: done or still waiting, and whether CI failed; read failures throw (`dismissStale`, handoff only, is the one write). `threadsOf` reads the unresolved threads (wait reuses the last answer). */
  function reviews(stallMinutes = 20, now = Date.now(), prNumber = env.number, pr = readPr(prNumber), graceMinutes = env.graceMinutes(), threadsOf = current => unresolvedThreads(current.number, current.reviewThreads), dismissStale = false) {
    useBaseSettings(pr);
    const { dismissals = [], ...verdict } = judgeReview(readFacts(pr, threadsOf), gate, { stallMinutes, now, graceMinutes, dismissStale });
    for (const { id, message } of dismissals) github.run(['api', `repos/${project.repository}/pulls/${pr.number}/reviews/${id}/dismissals`, '-X', 'PUT', '-f', `message=${message}`], { stdio: 'pipe' });
    return verdict;
  }

  return { reviews, readPr, useBaseSettings, isOptional, unresolvedThreads, baseMovement, filesText, baseSettings: () => gate };
}
