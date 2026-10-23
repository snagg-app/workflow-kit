// `check ISSUE`: the start verdict of an issue and the reasons behind it.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import assert from 'node:assert/strict';
import { result } from './board-result.mjs';
import { textInEveryLanguage } from './project-profile.mjs';
import { git, graphql, handoffHeading, issueProject, project, projectDirectory, rest, sessionOption, state, statuses, texts } from './board-context.mjs';
import { currentIssuePr, isOwn, openPrs, ownWork, startReasons } from './board-claims.mjs';
import { baseSetting, claimOf, commentClaims, decisionWait, feedbackNode, issueFeedback, logins, projectItem, projectStatus, readIssue, refOf, replyLine, validTagName } from './board-common.mjs';
import { stackBase } from './board-stack.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'check', run: 'checkCommand', hidden: true, summary: 'The start verdict of an issue (STARTABLE, BLOCKED, UNKNOWN, STACKABLE) and its reasons; `start` runs it first.',
    words: [{ name: 'ISSUE', kind: 'number' }], flags: { '--session': { value: 'ID', kind: 'id', help: 'The own session (default: the worktree, CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID).' } } },
];

/** Why native predecessors still hold an issue: open, closed without delivery, or unreadable. */
function predecessorReasons({ totalCount, nodes }) {
  const blocked = [], unknown = [], open = [];
  const readable = nodes.filter(Boolean);
  if (readable.length < totalCount) unknown.push(`only ${readable.length} of ${totalCount} predecessors are readable`);
  for (const predecessor of readable) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    if (predecessor.state === 'OPEN') { blocked.push(`blocked by ${label} (open)`); open.push(predecessor); }
    else if (!predecessor.stateReason) unknown.push(`${label} is closed without a readable reason`);
    // Only a completed predecessor delivered; not planned or duplicate needs a recorded decision.
    else if (predecessor.stateReason !== 'COMPLETED') {
      const reason = predecessor.stateReason.toLowerCase().replace('_', ' ');
      blocked.push(`blocked by ${label} (closed as ${reason}; record a decision)`);
    }
  }
  return { blocked, unknown, open };
}

function waitReasons(body) {
  const blocked = [], unknown = [], values = [];
  // The line is read in the words of every profile language: a ticket keeps the words it was written in.
  const labels = textInEveryLanguage('waitsUntil'), label = texts.waitsUntil;
  const strictLine = new RegExp(`^\\s*(?:[-*]\\s+)?(?:${labels.map(RegExp.escape).join('|')}):(.*)$`, 'i');
  const looseLine = new RegExp(`^[\\s>*_+\\-[\\]xX\\d.#|\`~=()]*(?:${labels.map(name => name.split(' ').map(RegExp.escape).join('\\s+')).join('|')})\\b`, 'i');
  const decision = new RegExp(`^(?:${textInEveryLanguage('decision').map(RegExp.escape).join('|')})[ \\t]+`);
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const strict = strictLine.exec(line);
    // Only ASCII separators go: trim() would strip a valid Unicode space from the tag name.
    if (strict) values.push(strict[1].replace(/^[ \t]+|[ \t]+$/g, ''));
    // Formatted variants (bold, quoted, numbered, checkbox) are not a readable condition, but no free pass either.
    else if (looseLine.test(line)) unknown.push(`unreadable line "${line.trim()}": write it as "${label}: <tag or UTC time>"`);
  }
  for (const wanted of values) {
    // Deferred until a decision: held while the line stands; whoever decides removes it (#514).
    if (new RegExp(`${decision.source}\\S`).test(wanted)) blocked.push(`${decisionWait} ${wanted.replace(decision, '')} (remove the line "${label}: ${wanted}" once decided)`);
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(wanted)) {
      const at = Date.parse(wanted);
      // A date such as 2026-02-30 rolls over; only the unchanged value counts.
      if (!Number.isFinite(at) || `${new Date(at).toISOString().slice(0, 16)}Z` !== wanted) unknown.push(`invalid "${label}: ${wanted}": no such UTC time`);
      else if (Date.now() < at) blocked.push(`waits until ${wanted} (UTC)`);
    } else if (validTagName(wanted)) {
      try {
        // matching-refs returns prefix matches (v0.1.1 finds v0.1.10); only the exact tag counts.
        const tags = rest(`repos/${project.repository}/git/matching-refs/tags/${wanted.split('/').map(encodeURIComponent).join('/')}`);
        if (!tags.some(tag => tag.ref === `refs/tags/${wanted}`)) blocked.push(`waits for tag ${wanted} (not found)`);
      } catch (error) {
        unknown.push(`cannot read tag ${wanted}: ${String(error.stderr || error.message).trim()}`);
      }
    } else unknown.push(`invalid "${label}: ${wanted}": use a tag name or a UTC time such as 2026-10-12T18:51Z`);
  }
  return { blocked, unknown };
}

const prFeedback = `comments(last:5){nodes{${feedbackNode}}} reviews(last:5){nodes{${feedbackNode}}}`;
function loadPrFeedback(issues) {
  const linked = issues.flatMap(issue => issue.closedByPullRequestsReferences?.nodes ?? []);
  assert.ok(linked.every(pr => typeof pr?.id === 'string' && pr.id), 'PR feedback ids are unreadable');
  assert.ok(linked.every(pr => ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)), 'PR feedback states are unreadable');
  const prs = linked.filter(pr => pr.state === 'OPEN');
  const ids = [...new Set(prs.map(pr => pr.id))];
  const feedback = new Map();
  for (let from = 0; from < ids.length; from += 100) {
    const batch = ids.slice(from, from + 100);
    const { nodes } = graphql(`query{nodes(ids:${JSON.stringify(batch)}){...on PullRequest{id ${prFeedback}}}}`);
    assert.ok(nodes?.length === batch.length && nodes.every((pr, index) => pr?.id === batch[index]
      && Array.isArray(pr.comments?.nodes) && Array.isArray(pr.reviews?.nodes)), 'PR feedback is unreadable; retry the read');
    for (const current of nodes) feedback.set(current.id, current);
  }
  for (const pr of prs) Object.assign(pr, feedback.get(pr.id));
}

/**
 * What happened on a ticket since the agent's last word, or undefined. The agent's word is the handoff (a heading with texts.handoff) or a comment with an "Agent: claude|codex" line,
 * never the login: agents and humans share it. Counts for an issue assigned to the login (and, with SESSION, claimed by it): everything after that word, and the issue
 * back in In progress or Automated review after the handoff. Any issue: an @mention of the login after it.
 * ponytail: reads the last 10 issue comments, 5 PR comments and 5 reviews, and any agent's marker answers; replace when feedback is missed or a second agent shares a ticket.
 */
function feedback(issue, login, session) {
  const mine = issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === login.toLowerCase()) && (!session || isOwn(issue, session));
  const events = [...(issue.comments?.nodes ?? []), ...openPrs(issue).flatMap(pr => [...(pr.comments?.nodes ?? []), ...(pr.reviews?.nodes ?? [])])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const anchor = events.findLastIndex(event => handoffHeading.test(event.body) || replyLine.test(event.body));
  const mention = new RegExp(`(?<![\\w-])@${RegExp.escape(login)}(?![\\w-])`, 'i'), status = projectStatus(issue), tracked = mine && anchor >= 0;
  const seen = events.slice(anchor + 1).filter(event => tracked || mention.test(event.body));
  const why = [tracked && handoffHeading.test(events[anchor].body) && [statuses.inProgress, statuses.automatedReview].includes(status) && `back in ${status} after the handoff`,
    seen.length && (tracked ? `${seen.length} new comment(s) or review(s) since your last reply or handoff` : `mentions @${login}`)].filter(Boolean);
  return why.length ? { reason: why.join('; '), url: (seen.at(-1) ?? events[anchor]).url } : undefined;
}

/** The open issues assigned to the login, for `check` (one paged search); `next` already holds all open issues. */
function assignedIssues(login) {
  const rows = [];
  for (let after; ;) {
    const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:30,after:$after){
    issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{number title assignees(first:10){nodes{login}} ${issueFeedback}
    closedByPullRequestsReferences(first:10){nodes{state body id}}
    projectItems(first:100){nodes{project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}`,
    { q: `repo:${issueProject.repository} is:issue is:open assignee:${login}`, ...(after && { after }) });
    rows.push(...search.nodes);
    if (!search.pageInfo.hasNextPage) {
      assert.ok(rows.length >= search.issueCount, `Search returned ${rows.length} of ${search.issueCount} issues of ${login}; the own work would be incomplete`);
      loadPrFeedback(rows);
      return rows;
    }
    assert.ok(search.pageInfo.endCursor && search.pageInfo.endCursor !== after, 'Search pagination did not advance');
    after = search.pageInfo.endCursor;
  }
}

/** True when open predecessors are the only thing holding the issue: a stack may then replace the wait. */
const heldOnlyByOpenPredecessors = (reasons, predecessors) => predecessors.open.length > 0 && reasons.length === predecessors.open.length;

/** STARTABLE and STACKABLE both allow work; check() reports the latter with exit 4, which only the `check` command keeps. */
const mayStart = judged => ['STARTABLE', 'STACKABLE'].includes(judged.verdict);

/** Verdict inputs of one issue, shared by the issue itself and its sub-issues. */
function issueReasons(issue) {
  const status = projectStatus(issue);
  const blocked = [], unknown = [];
  if (issue.state !== 'OPEN') blocked.push('issue is closed');
  if (!projectItem(issue)) unknown.push(`issue is not on ${issueProject.url}`);
  else if (!status) unknown.push('the Project status is unset');
  else if ([statuses.backlog, statuses.done].includes(status)) blocked.push(`status is ${status}`);
  else if (![statuses.ready, statuses.inProgress, statuses.automatedReview, statuses.humanReview].includes(status)) unknown.push(`unknown status ${status}`);
  const predecessors = predecessorReasons(issue.blockedBy);
  blocked.push(...predecessors.blocked);
  unknown.push(...predecessors.unknown);
  const waits = waitReasons(issue.body);
  blocked.push(...waits.blocked);
  unknown.push(...waits.unknown);
  return { status, blocked, unknown, predecessors };
}

const verdictOf = ({ blocked, unknown }) => blocked.length ? 'BLOCKED' : unknown.length ? 'UNKNOWN' : 'STARTABLE';

/** Who works on an open predecessor and where its PRs stand, from what loadDeliveries read; a list cut at 10 is never presented as complete. */
function predecessorLine(predecessor) {
  const { totalCount, nodes } = predecessor.closedByPullRequestsReferences;
  const prs = nodes.filter(Boolean).map(pr => `${refOf(pr.repository, pr.number)} ${pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase()}`);
  const cut = totalCount > nodes.length ? ` (first ${nodes.length} of ${totalCount})` : '';
  return `predecessor ${refOf(predecessor.repository, predecessor.number)}: assignees: ${predecessor.assignees ? logins(predecessor) || 'none' : 'unreadable'}; PRs: ${prs.join(', ') || 'none'}${cut}`;
}

/** The base branch the Project field names for the issue (empty without a setting or a value). */
function baseOf(issue) {
  const setting = baseSetting(), found = projectItem(issue)?.base, value = (found?.name ?? found?.text ?? '').trim();
  return { setting, value, branch: setting && value && (Object.hasOwn(setting.values ?? {}, value) ? setting.values[value] : setting.pattern.replace('{value}', () => value)) };
}

/** The base the Project field names and whether HEAD stands on it; local git only, no fetch. Information only, never a verdict. */
function baseLines(issue, stacked) {
  const { setting, value, branch } = baseOf(issue);
  if (!setting) return [];
  if (!value) return [`note: the Project field ${setting.field} is empty; no base branch to name`];
  const remote = `origin/${branch}`;
  // Git's exit code: 0 yes, 1 the expected "no", anything else is git failing (no checkout, no git) and says nothing about the base.
  const exit = (...args) => { try { git(...args); return 0; } catch (error) { return error.status ?? -1; } };
  const lines = [`base: ${branch} (${setting.field})`];
  let code = exit('check-ref-format', `refs/heads/${branch}`); // --branch would die with 128 instead of 1
  if (code === 1) return [...lines, `note: ${branch} is not a valid branch name; fix the value of ${setting.field}`];
  if (code === 0) code = exit('rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`);
  if (code === 1) return [...lines, `note: ${remote} is not known in this checkout; run git fetch origin`];
  // A stack starts from its base PR's branch, and an issue that has a branch was started: HEAD is not the base's business then.
  if (code === 0 && !stacked && !(issue.branches ?? []).some(ref => new RegExp(`^[\\w.-]+/${issue.number}-`).test(ref.name))) code = exit('merge-base', '--is-ancestor', `refs/remotes/${remote}`, 'HEAD');
  if (code === 1) lines.push(`note: HEAD is not on ${remote}; create the branch from there (git fetch origin, then git switch -c <branch> --no-track ${remote})`);
  else if (code) lines.push(`note: git could not check ${remote} (exit ${code}); no advice on the base`);
  return lines;
}

/** Without `claims` (status transitions) only the verdict prints; the `check` command adds the open PRs with their claims and sub-issues. Information only. */
function check(issue = readIssue(), claims, currentPrNumber) {
  let current = currentIssuePr(issue);
  if (currentPrNumber !== undefined && !current.unknown && current.number !== currentPrNumber) {
    current = current.number === undefined ? { unknown: `PR #${currentPrNumber} is not the unique open local PR linked to this issue` } : { partial: true };
  }
  const { status, blocked, unknown, predecessors } = issueReasons(issue);
  const notes = [];
  if (claims) try {
    const found = startReasons(issue, claims.session, claims.takeover);
    blocked.push(...found.blocked);
    notes.push(...found.notes);
  } catch (error) { unknown.push(`branches are unreadable: ${String(error.stderr || error.message).trim()}`); }
  // Only open predecessors hold the issue (no other blocker, not even foreign work or a status): look for the PR to stack on.
  state.stackedOn = undefined;
  const heldOnlyByOpen = heldOnlyByOpenPredecessors(blocked, predecessors);
  if (current?.unknown && (currentPrNumber !== undefined || heldOnlyByOpen)) {
    unknown.push(current.unknown);
    if (heldOnlyByOpen) blocked.length = 0;
  }
  if (heldOnlyByOpen && !unknown.length) {
    const stack = stackBase(predecessors.open, current?.number);
    if (stack.pr) {
      state.stackedOn = stack.pr;
      notes.push(...blocked.map(reason => `${reason}; delivered by PR #${stack.pr.number}`));
      blocked.length = 0;
    } else if (stack.unknown.length && !stack.refused.length) {
      unknown.push(...stack.unknown);
      blocked.length = 0;
    // A definitive refusal stays BLOCKED, whatever else is unreadable: a retry cannot lift it.
    } else notes.push(...stack.refused.map(reason => `not stackable: ${reason}`), ...stack.unknown.map(reason => `unreadable: ${reason}`));
  }
  // Finish first: another issue of the caller in In progress or Automated review holds a new start (not a resume, not a stack on that very work).
  if (claims?.session && !blocked.length && !unknown.length && !isOwn(issue, claims.session)) try {
    const login = issue.viewer.login, rows = assignedIssues(login), work = ownWork(rows, login, claims.session);
    // Feedback on a handed-off issue of the own session comes before new work too (#554).
    const mine = work.map(own => [own, `it is your open work (${projectItem(own).status.name}); hand it off before starting another issue`]);
    for (const row of rows.filter(row => !work.includes(row) && isOwn(row, claims.session))) {
      const found = feedback(row, login, claims.session);
      if (found) mine.push([row, `it has feedback (${found.reason}, ${found.url}); answer it in the ticket or hand it off again before starting another issue`]);
    }
    // Own work that is the base of the stack is continued, not left behind; any other own issue still comes first.
    const base = own => state.stackedOn && predecessors.open.some(open => open.number === own.number && open.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase());
    blocked.push(...mine.filter(([own]) => own.number !== issue.number && !base(own)).map(([own, why]) => `finish #${own.number} first: ${why}`));
  } catch (error) { unknown.push(`own open work is unreadable: ${String(error.stderr || error.message).trim()}`); }
  const plain = verdictOf({ blocked, unknown });
  const verdict = state.stackedOn && plain === 'STARTABLE' ? 'STACKABLE' : plain;
  const lines = [];
  // Only where loadDeliveries ran (open predecessors alone hold the issue) the PRs are known; elsewhere nothing is claimed.
  for (const predecessor of predecessors.open) if (predecessor.closedByPullRequestsReferences?.nodes) lines.push(predecessorLine(predecessor));
  if (state.stackedOn) lines.push(state.stackedOn.state === 'MERGED'
    ? `stack base: PR #${state.stackedOn.number} is already merged into ${state.stackedOn.baseRefName}: no stack, work on ${state.stackedOn.baseRefName}; see docs/CONTRIBUTING.md#stacked-pull-requests`
    : `stack base: PR #${state.stackedOn.number}${state.stackedOn.stackNumber ? ` in stack #${state.stackedOn.stackNumber}` : ''} (branch ${state.stackedOn.headRefName}, base ${state.stackedOn.baseRefName}); see docs/CONTRIBUTING.md#stacked-pull-requests`);
  for (const note of notes) lines.push(`note: ${note}`);
  if (claims) lines.push(...baseLines(issue, state.stackedOn));
  if (claims) {
    const linked = issue.closedByPullRequestsReferences;
    const prs = openPrs(issue).map(pr => `${refOf(pr.repository, pr.number)} (Session ${claimOf(pr)?.[2] ?? 'unknown'})`);
    // A list cut at 100 is never presented as complete.
    const cut = linked?.totalCount > linked?.nodes?.length ? ` (first ${linked.nodes.length} of ${linked.totalCount})` : '';
    if (prs.length) lines.push(`open PR: ${prs.join(', ')}${cut}`);
    else if (commentClaims(issue).length) lines.push(`claim: session ${commentClaims(issue).at(-1)[2]} (no PR yet)`);
  }
  const children = [];
  if (claims && issue.subIssues?.nodes?.length) {
    if (issue.subIssues.totalCount > issue.subIssues.nodes.length) lines.push(`note: ${issue.subIssues.nodes.length} of ${issue.subIssues.totalCount} sub-issues listed`);
    for (const child of issue.subIssues.nodes) {
      children.push(`${refOf(child.repository, child.number)}  ${projectItem(child)?.status?.name ?? '-'}  ${logins(child) || '-'}  ${verdictOf(issueReasons(child))}`);
    }
  }
  // STACKABLE is not 0: a caller that knows only STARTABLE must not start it without the stack rules.
  return result({ STARTABLE: 'ok', BLOCKED: 'failed', UNKNOWN: 'error', STACKABLE: 'again' }[verdict], verdict, { bullet: '- ',
    title: [`${issueProject.repository}#${issue.number} ${issue.title}`, `status: ${status ?? '-'}, assignees: ${logins(issue) || 'none'}`],
    blockers: [...blocked, ...unknown], notes: [...lines, ...children],
    data: { issue: issue.number, status, stackedOn: state.stackedOn?.number } });
}

const checkCommand = () => check(readIssue(true), { session: sessionOption() });

export { predecessorReasons, waitReasons, loadPrFeedback, feedback, heldOnlyByOpenPredecessors, mayStart, baseOf, check, checkCommand };
