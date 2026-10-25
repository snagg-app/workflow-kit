// The review gate: one look at a PR head (CI, bots, threads, change requests) and the project settings it reads from the PR's base branch.
// The facts are read in review-facts.mjs and judged in review-verdict.mjs; this module joins them for `wait`, `handoff`, `done` and `merge`.
import assert from 'node:assert/strict';
import { readProfileAt } from './project-profile.mjs';
import { filesText, judgeReview, optionalReviewers, reviewerKey } from './review-verdict.mjs';
import { github, graceOption, number, project, memory } from './board-context.mjs';
import { baseMovement, readFacts, readPr, unresolvedThreads } from './review-facts.mjs';

// The review gate (`reviews`, so `wait`, `handoff` and `merge`) takes these settings from the target branch of the PR as it is now, never from
// the checkout: a stale checkout would apply rules the branch has since changed (#448).
// ponytail: one REST read per look, no cache; cache by base commit if the REST quota ever gets tight.
function useBaseSettings(pr) {
  assert.ok(pr.baseRefName, 'The PR base is not readable');
  const base = readProfileAt(github.rest, project.repository, pr.baseRefName);
  memory.gate = { ...project, ...Object.fromEntries(['awaitApps', 'optionalReviewers', 'updateBranchChecks', 'ignoredChecks', 'doneBaseMerge', 'reviewRequiredPaths'].map(key => [key, base[key]])) };
  memory.optional = undefined;
}
const isOptional = name => (memory.optional ??= optionalReviewers(memory.gate)).has(reviewerKey(name));

/** One look at the PR head: done or still waiting, and whether CI failed; read failures throw (`dismissStale`, handoff only, is the one write). `threadsOf` reads the unresolved threads (wait reuses the last answer). */
function reviews(stallMinutes = 20, now = Date.now(), prNumber = number, pr = readPr(prNumber), graceMinutes = graceOption(), threadsOf = current => unresolvedThreads(current.number, current.reviewThreads), dismissStale = false) {
  useBaseSettings(pr);
  const { dismissals = [], ...verdict } = judgeReview(readFacts(pr, threadsOf), memory.gate, { stallMinutes, now, graceMinutes, dismissStale });
  for (const { id, message } of dismissals) github.write('PUT', `repos/${project.repository}/pulls/${pr.number}/reviews/${id}/dismissals`, { fields: { message } });
  return verdict;
}

const baseSettings = () => memory.gate ?? project;
export { reviews, readPr, useBaseSettings, isOptional, unresolvedThreads, baseMovement, filesText, baseSettings };
