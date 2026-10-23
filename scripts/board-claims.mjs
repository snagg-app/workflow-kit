// Who works on an issue: its open PRs, claims, branches and stale work.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import assert from 'node:assert/strict';
import { issueProject, number, project, rest, staleHours, state, statuses } from './board-context.mjs';
import { baseOf } from './board-check.mjs';
import { claimOf, commentClaims } from './claim.mjs';
import { ago, defaultBranchName, projectItem, projectStatus, refOf, sameLogin, stackOrderText } from './board-common.mjs';

/**
 * Milliseconds since the last activity: the newest of the issue (comments), its Project item (status) and its open PR (push, comments, reviews),
 * all read with the issue anyway. undefined when GitHub gave no time.
 * ponytail: PR activity includes bot comments, so a PR that a bot keeps touching never goes stale; replace with the newest commit date of the PR head if that bites.
 */
function idleMs(issue) {
  const prs = openPrs(issue);
  const times = [issue.updatedAt, projectItem(issue)?.updatedAt, ...prs.map(pr => pr.updatedAt)].map(time => Date.parse(time)).filter(Number.isFinite);
  return times.length ? Date.now() - Math.max(...times) : undefined;
}

const openPr = issue => openPrs(issue).find(pr => pr.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase());

/** The open PRs that use this branch as their base: a PR with such a dependent is a lower layer of a stack. */
function dependentPrs(branch) {
  const dependents = rest(`repos/${project.repository}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`);
  assert.ok(Array.isArray(dependents), 'The open PRs on the branch are unreadable');
  return dependents;
}

/** The blocker line for conflicts; a PR that has a PR on top of it is a lower layer and gets the order. Read only for a DIRTY PR, an unreadable lookup keeps the plain conflict. */
const conflictLine = pr => {
  let lower = false;
  try { lower = dependentPrs(pr.headRefName).length > 0; } catch { /* the plain verdict stands */ }
  return `blocker: merge conflicts${lower ? ` in a lower stack layer, which locks the whole stack: ${stackOrderText}` : ''}`;
};
const conflicting = issue => projectItem(issue)?.status?.name === statuses.humanReview && openPr(issue)?.mergeStateStatus === 'DIRTY';

/** Abandoned: no activity for staleHours, or a Human-review PR with conflicts (it is not mergeable, so nobody finishes it). Work on such an issue has expired. */
const isStale = (issue, idle = idleMs(issue)) => idle > staleHours * 3_600_000 || conflicting(issue);
const openPrs = issue => {
  const open = (issue.closedByPullRequestsReferences?.nodes ?? []).filter(pr => pr?.state === 'OPEN');
  return state.adoptedPr && !open.some(pr => pr.number === state.adoptedPr.number) ? [...open, state.adoptedPr] : open;
};

/** The open PR of this repository that names the issue with "Refs #N" or sits on a branch `<agent>/N-…`. ponytail: the newest 100 open PRs only. */
function refsPr() {
  const ref = `${issueProject === project ? '' : issueProject.repository}#${number}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = rest(`repos/${project.repository}/pulls?state=open&per_page=100`).find(pr =>
    new RegExp(`^[\\w.-]+/${number}-`).test(pr.head.ref) || new RegExp(`(?<![\\w/])Refs:?\\s+${ref}(?!\\d)`, 'i').test(pr.body ?? ''));
  return found && { number: found.number, state: 'OPEN', body: found.body ?? '', headRefName: found.head.ref, updatedAt: found.updated_at, repository: { nameWithOwner: project.repository } };
}

const workBranches = issue => (issue.branches ?? []).map(branch => branch.name).filter(name => new RegExp(`^[\\w.-]+/${issue.number}-`).test(name));

/** The current local PR of an issue, or why linked-PR data cannot safely identify one. */
function currentIssuePr(issue) {
  const linked = issue.closedByPullRequestsReferences;
  if (!Number.isSafeInteger(linked?.totalCount) || linked.totalCount < 0 || !Array.isArray(linked.nodes)
    || linked.nodes.length !== linked.totalCount || linked.nodes.some(pr => !pr)) {
    return { unknown: 'the linked PRs of this issue are not completely readable' };
  }
  const open = [];
  for (const pr of linked.nodes) {
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) return { unknown: 'an issue-linked PR has unreadable state' };
    if (pr.state !== 'OPEN') continue;
    const repository = pr.repository?.nameWithOwner;
    if (typeof repository !== 'string') return { unknown: `the repository of open PR #${pr.number ?? '?'} is unreadable` };
    if (repository.toLowerCase() !== project.repository.toLowerCase()) continue;
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) return { unknown: 'an open issue-linked PR has unreadable number' };
    open.push(pr);
  }
  if (open.length > 1) return { unknown: `the issue has multiple open PRs in ${project.repository}` };
  return { number: open[0]?.number };
}

/** A partial PR only mentions the issue (`Refs #N`, no closing link) while exactly one other open PR closes it: it has its own gate and never moves the issue's status. */
const isPartialPr = (issue, prNumber) => { const { number } = currentIssuePr(issue); return number !== undefined && number !== prNumber; };
// ponytail: sessions are told apart by the id the driver passes, not authenticated; Claude and Codex share one login.
/** The open PR of the issue whose claim names SESSION. */
const ownPr = (issue, session) => session ? openPrs(issue).find(pr => claimOf(pr)?.[2] === session) : undefined;

/** Whether the claim of the issue is SESSION's: the open PR's, else the newest claim comment. */
const isOwn = (issue, session) => Boolean(session) && (openPrs(issue).length ? Boolean(ownPr(issue, session)) : commentClaims(issue).at(-1)?.[2] === session);

/**
 * Work of someone on the issue: an open PR that closes it (a Draft too) or a branch `<agent>/<number>-…`. Only the claim of the
 * caller's own session on a PR lifts it, so a driver cannot start in parallel to an agent whose PR names another session or none.
 */
function workReasons(issue, session, takeover) {
  const own = session ? `no claim of session ${session}` : 'pass --session ID to prove it is yours';
  const prs = openPrs(issue);
  // An abandoned PR (see isStale) may be taken over with --session, a fresh one only on purpose with start --takeover (#548): start writes the session into its body.
  const claim = prs.length ? undefined : commentClaims(issue).at(-1);
  const mayTake = session && (prs.length || claim) && (takeover || isStale(issue));
  const heads = new Set(prs.map(pr => pr.headRefName));
  const describe = pr => `open PR ${refOf(pr.repository, pr.number)}${pr.headRefName ? ` (branch ${pr.headRefName}${claimOf(pr) ? `, ${claimOf(pr)[0]}` : ''})` : ''}`;
  const blocked = mayTake ? [] : prs.map(pr => `${describe(pr)} closes this issue; ${own}`);
  const why = isStale(issue) ? `stale %: no activity for ${ago(idleMs(issue))}` : '%: --takeover';
  const notes = mayTake ? prs.map(pr => `${why.replace('%', describe(pr))}; start takes it over`) : [];
  if (claim) (mayTake ? notes : blocked).push(mayTake ? `${why.replace('%', `claim of session ${claim[2]}`)}; start takes it over` : `claimed by ${claim[1]} (session ${claim[2]}) without a PR yet; ${own}`);
  // A branch without an open PR (#504): without own commits it holds nothing, without a commit for staleHours it is orphaned (a note), else it holds.
  for (const branch of workBranches(issue).filter(branch => !heads.has(branch))) {
    const { ahead, idle } = branchWork(issue, branch), agent = branch.split('/')[0];
    if (!ahead) continue;
    // --takeover (#655): a pushed branch without a PR is what a predecessor hands over; start continues on it.
    if (takeover && mayTake) notes.push(`branch ${branch} (agent ${agent}) has no open PR: --takeover; start continues on it`);
    else if (idle !== undefined && isStale(issue, idle)) notes.push(`orphaned branch ${branch} (agent ${agent}): no open PR, no commit for ${ago(idle)}; continue on it or branch anew`);
    else blocked.push(`branch ${branch} (agent ${agent}${idle === undefined ? '' : `, last commit ${ago(idle)} ago`}) belongs to this issue; ${own}`);
  }
  return { blocked, notes };
}

/**
 * Own commits of a branch against the issue's base and the age of its newest commit: one REST compare. The commits come oldest first, one page of 100:
 * with more, `idle` is undefined (that many commits are active work). A compare that fails (no base) is an error of the caller: `check` is UNKNOWN, `next` holds that issue.
 * ponytail: one compare per found branch, also per Ready issue in `next`, uncached; cache by branch if `next` gets slow.
 * ponytail: over 100 commits the age is unknown and the branch holds; read the last page of the compare if that bites.
 */
function branchWork(issue, branch) {
  const ref = name => name.split('/').map(encodeURIComponent).join('/');
  const base = baseOf(issue).branch || defaultBranchName();
  const { ahead_by: ahead, commits = [] } = rest(`repos/${project.repository}/compare/${ref(base)}...${ref(branch)}?per_page=100`);
  assert.ok(Number.isSafeInteger(ahead), `The comparison of ${branch} with ${base} is unreadable`);
  const newest = ahead && commits.length === ahead ? Date.parse(commits.at(-1).commit.committer.date) : NaN;
  return { ahead, idle: Number.isFinite(newest) ? Date.now() - newest : undefined };
}

/** Logins on the issue other than the caller: their claim may predate any PR (#572). */
const foreignAssignees = issue => issue.assignees.nodes.map(user => user.login).filter(login => !sameLogin(login, issue.viewer.login));

/** What the open PRs, branches and assignees of an issue hold against a start by SESSION: one rule for `check` and `next`. */
function startReasons(issue, session, takeover) {
  // An open PR of another repository that names the session is no claim of this issue (#588).
  if (session && openPrs(issue).length ? claimOf(openPr(issue) ?? {})?.[2] === session : isOwn(issue, session)) return { blocked: [], notes: [] };
  const found = workReasons(issue, session, takeover), others = foreignAssignees(issue);
  if (others.length && !takeover) found.blocked.push(`assigned to ${others.join(', ')}; pass --takeover to take it over`);
  return found;
}

/** Unfinished work of the caller: rows (number, assignees, projectItems, closedByPullRequestsReferences) in In progress or Automated review that are assigned to the login and whose open PR names SESSION. */
function ownWork(rows, login, session) {
  return rows.filter(row => [statuses.inProgress, statuses.automatedReview].includes(projectStatus(row))
    && row.assignees.nodes.some(assignee => assignee.login.toLowerCase() === login.toLowerCase()) && isOwn(row, session));
}

export { idleMs, openPr, dependentPrs, conflictLine, conflicting, isStale, openPrs, refsPr, workBranches, currentIssuePr, isPartialPr, ownPr, isOwn, branchWork, foreignAssignees, startReasons, ownWork };
