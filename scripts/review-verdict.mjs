// The review verdict: from the facts of one PR head (review-facts.mjs) to done or waiting, red or not, the reasons and the lines to print.
// No reads and no writes: `judgeReview` only looks at its arguments. The facts are a plain object; the reader makes the fields that cost a
// request lazy, so a red head never reads what only a green one needs. A test hands in a plain object.
import assert from 'node:assert/strict';

export const login = user => user?.login?.replace(/\[bot\]$/, '');
export const isBot = user => user?.type === 'Bot';
// "optionalReviewers" lists bot logins or app slugs whose traces are shown but never awaited, stalled or counted as red
// (a review bot on a free plan that is rate limited most of the time). Their open threads and change requests still block; `handoff` dismisses a change request once all threads are resolved.
export const reviewerKey = name => name?.trim().toLowerCase().replace(/^(@|app\/)/, '').replace(/\[bot\]$/, '');
// The lists are checked where the profile is read (project-profile.mjs); `settings` is its view, or a test's plain object.
export const optionalReviewers = settings => new Set((settings.optionalReviewers ?? []).map(reviewerKey));
// "updateBranchChecks" lists checks whose failure only asks for the base to be merged into the PR branch (#383, e.g. a retarget restart check): `merge` does that itself.
export const updateBranchChecks = settings => new Set(settings.updateBranchChecks ?? []);
export const filesText = files => files.slice(0, 10).join(', ') + (files.length > 10 ? `, and ${files.length - 10} more` : '');

const passed = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** When the head's CI started. CI starts on push, so the first check suite dates the push. Before that the commit date is a
 * conservative lower bound: it can only add traces, never hide one. A bot sees the head through the same push event that opens the suites, so no trace predates them. */
export function headPushed(pr) {
  const { commit } = pr.commits.nodes[0];
  assert.equal(commit.oid, pr.headRefOid, 'Head commit not readable');
  assert.equal(commit.checkSuites.nodes.length, commit.checkSuites.totalCount, 'Not every check suite is readable');
  const suites = commit.checkSuites.nodes.map(suite => Date.parse(suite.createdAt));
  return suites.length ? Math.min(...suites) : Date.parse(commit.committedDate);
}

/** Distinct heads pushed after the PR first became ready; the head that set Ready is no correction, a force-push counts as one push. Null while there was no Ready.
 * ponytail: the log is the newest 100 pushes and a PR opened ready that was converted to Draft and readied again counts from its second Ready; replace when the timeline lists pushes. */
function correctionPushes(pr, pushes) {
  const first = pr.firstReadyEvents?.nodes?.[0]?.createdAt ?? (pr.isDraft ? undefined : pr.createdAt);
  if (!first) return null;
  const since = Date.parse(first);
  assert.ok(Number.isFinite(since), 'The first Ready time is unreadable');
  const log = pushes().filter(entry => !/^0+$/.test(entry.after));
  // The head that set Ready is the latest push up to the Ready event; pushing back to it later is no new head.
  const atReady = log.filter(entry => Date.parse(entry.timestamp) <= since).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0]?.after;
  return new Set(log.filter(entry => Date.parse(entry.timestamp) > since && entry.after !== atReady).map(entry => entry.after)).size;
}

/** When the branch was set to the head. A commit pushed earlier to another branch has older check suites and commit date, so only the ref's push log dates it. */
function headSetAt(pr, log) {
  // The same commit can be pushed twice (X, Y, X again); the latest push counts, whatever the order.
  const pushes = log.filter(entry => entry.after === pr.headRefOid);
  assert.ok(pushes.length, 'Push time of the head is not readable; retry the read');
  const time = Math.max(...pushes.map(entry => Date.parse(entry.timestamp)));
  assert.ok(Number.isFinite(time), 'Push time of the head is unreadable');
  return time;
}

/**
 * The verdict for one look at the PR head: { done, failed, reasons, lines, pr, baseOnly?, comments?, threads?, dismissals? }.
 * `facts` (review-facts.mjs): pr, pushLog, baseMovement, headRuns, stackOrderText, conflictLine, comments, sonar (check -> { total, lines } or { error }),
 * reviewList, reactions, inline, threads; a field is read where the rules need it, in this order. `settings`: the PR base's awaitApps, optionalReviewers,
 * updateBranchChecks. `options`: stallMinutes, now, graceMinutes, dismissStale. `dismissals` are the stale change requests the caller is to dismiss.
 */

// The checks of one head: which job counts (the newest executed run), which suite is awaited.
  const runOf = check => check.checkSuite?.workflowRun?.databaseId ?? check.checkSuite?.databaseId;
  const jobKey = check => JSON.stringify([check.checkSuite?.app?.slug, check.checkSuite?.workflowRun?.workflow?.id, check.name]);
  const orderable = check => check.__typename === 'CheckRun' && Number.isSafeInteger(runOf(check));

/** Checks the head's jobs and returns the live ones. */
function judgeChecks(ctx, s) {
  const { pr, settings, commit, isOptionalCheck } = ctx;
  const { lines, waiting, reasons, baseReasons } = s;
  const baseChecks = updateBranchChecks(settings);
  const contexts = commit.statusCheckRollup?.contexts ?? { totalCount: 0, nodes: [] };
  assert.equal(contexts.nodes.length, contexts.totalCount, 'Not every check is readable');
  // The usual Draft-then-Ready sequence starts a second workflow run on the same commit and cancels the first, so the
  // first run's jobs are superseded. A job (app, workflow id, name) is superseded only by the same job of a NEWER run,
  // never by another job of its own run: two jobs of one run that share a display name both count, and so does a
  // newest run that is cancelled. The workflow is told apart by its id (two files can share a display name). A check
  // without a run or suite id cannot be ordered and stays as it is.
  // A SKIPPED run executed nothing, so it proves nothing and replaces nothing: a job's verdict is that of its newest run that
  // is not SKIPPED (a cancelled or failed earlier run stays the verdict, a real retry decides). Only a job whose runs were
  // all SKIPPED counts as skipped, which is how an optional job looks.
  const newestSkipped = new Map(), newestExecuted = new Map();
  for (const check of contexts.nodes.filter(orderable)) {
    const newest = check.conclusion === 'SKIPPED' ? newestSkipped : newestExecuted;
    newest.set(jobKey(check), Math.max(newest.get(jobKey(check)) ?? -Infinity, runOf(check)));
  }
  const decisiveRun = check => newestExecuted.get(jobKey(check)) ?? newestSkipped.get(jobKey(check));
  const live = contexts.nodes.filter(check => !orderable(check) || runOf(check) === decisiveRun(check));
  for (const check of live.filter(check => orderable(check) && newestSkipped.get(jobKey(check)) > runOf(check))) {
    lines.push(`note: ${check.name} was SKIPPED in a newer run, which proves nothing; run ${runOf(check)} decides`);
  }
  for (const check of live) {
    const label = check.name ?? check.context;
    const pending = check.__typename === 'CheckRun' ? check.status !== 'COMPLETED' : ['PENDING', 'EXPECTED'].includes(check.state);
    // An optional reviewer's check is shown and never decides: not awaited, not red.
    if (isOptionalCheck(check)) {
      lines.push(`check ${label}: ${pending ? 'pending' : check.conclusion ?? check.state}${check.title || check.description ? ` (${check.title || check.description})` : ''} [optional reviewer, not awaited]`);
      continue;
    }
    // CI never stalls: a running check is not success however long it takes.
    if (pending) { waiting.push({ text: `check ${label}`, since: Infinity }); continue; }
    const result = check.conclusion ?? check.state;
    if (!passed.has(result)) {
      s.failed = true;
      const asks = baseChecks.has(label);
      reasons.push(`check ${label} ${result}${asks ? ` asks for the base: run board.mjs merge ${pr.number} or merge the base and push` : ''}`);
      if (asks) baseReasons.add(reasons.at(-1));
    }
    // Descriptions carry results such as "Review rate limited" behind a green state.
    lines.push(`check ${label}: ${result}${check.title || check.description ? ` (${check.title || check.description})` : ''}`);
  }
  if (contexts.nodes.every(isOptionalCheck)) waiting.push({ text: 'first CI check', since: Infinity });
  return { contexts, live };
}

/** Suites without runs: a workflow that is about to report, or that failed to start. */
function judgeSuites({ settings, commit, isOptional }, s) {
  const { lines, waiting, reasons } = s;
  // An Actions suite without runs is a triggered workflow about to report. Other apps (Sonar, CodeRabbit,
  // Renovate …) open a suite on every push and often never run it, so they count only when the project
  // lists them in "awaitApps" (analyzers such as SonarCloud create their run only when finished). Both may stall.
  const awaited = new Set(['github-actions', ...settings.awaitApps ?? []].filter(slug => !isOptional(slug)));
  // A suite of a NEWER run of the same workflow replaces an empty one (Draft then Ready cancels the first run before it
  // reports). The replacing suite then answers for the workflow with its own status and conclusion, runs or not: its
  // check runs alone would show only the jobs reported so far. Another workflow or app never replaces it.
  const suiteFlow = suite => JSON.stringify([suite.app?.slug, suite.workflowRun?.workflow?.id]);
  const suiteRun = suite => suite.workflowRun?.databaseId;
  const empty = suite => !suite.checkRuns.totalCount;
  // An empty ACTION_REQUIRED suite is a pending approval, not a result: beside another suite of its workflow that has runs it counts for nothing.
  const flowsWithRuns = new Set(commit.checkSuites.nodes.filter(suite => !empty(suite)).map(suiteFlow));
  const flowSuites = commit.checkSuites.nodes.filter(suite => !(empty(suite) && suite.conclusion === 'ACTION_REQUIRED' && flowsWithRuns.has(suiteFlow(suite))));
  const newestSuiteRun = new Map();
  for (const suite of flowSuites.filter(suite => Number.isSafeInteger(suiteRun(suite)))) {
    newestSuiteRun.set(suiteFlow(suite), Math.max(newestSuiteRun.get(suiteFlow(suite)) ?? -Infinity, suiteRun(suite)));
  }
  const replaced = suite => Number.isSafeInteger(suiteRun(suite)) && suiteRun(suite) < newestSuiteRun.get(suiteFlow(suite));
  const replacedEmpty = new Set(flowSuites.filter(suite => awaited.has(suite.app?.slug) && empty(suite) && replaced(suite)).map(suiteFlow));
  for (const suite of flowSuites.filter(suite => awaited.has(suite.app?.slug) && !replaced(suite) && (empty(suite) || replacedEmpty.has(suiteFlow(suite))))) {
    // A suite with runs is judged by CI that never stalls; an empty one is a workflow that may never report.
    if (suite.status !== 'COMPLETED') waiting.push({ text: `check suite ${suite.app.slug}${empty(suite) ? ' without runs' : ' still running'}`, since: empty(suite) ? Date.parse(suite.createdAt) : Infinity });
    // A workflow that fails to start (STARTUP_FAILURE) completes its suite without any run to show it.
    else if (!passed.has(suite.conclusion)) {
      s.failed = true;
      reasons.push(`check suite ${suite.app.slug} ${suite.conclusion}`);
      lines.push(`check suite ${suite.app.slug}: ${suite.conclusion}`);
    }
  }
}

/** Information only: the correction cap and the base movement. */
function judgeProgress({ pr, facts }, { lines }) {
  const pushes = () => facts.pushLog;
  // The review loop stops pushing after two corrections (docs/CONTRIBUTING.md#review-loop); nothing enforces it, so say where the PR stands.
  // It is read before the red verdict, because a red head is when the next correction is weighed.
  try {
    const corrections = correctionPushes(pr, pushes);
    if (corrections !== null) {
      lines.push(`correction pushes after ready: ${corrections}`);
      if (corrections >= 2) lines.push('cap reached: collect non-blocking findings in one follow-up issue');
    }
  } catch (error) {
    // The count is information only: an unreadable one never changes the verdict (neither red into ERROR nor green into ERROR).
    lines.push(`note: correction pushes unreadable (${error.message})`);
  }
  // The base moves whenever other PRs merge; PR CI already tests the merge result, so a base merge only pays off where both sides changed files. Information only.
  try {
    const moved = facts.baseMovement;
    if (moved) {
      lines.push(`base moved: ${moved.behind} commits since merge-base (${pr.baseRefName})${moved.shared.length ? '; merge it once before the next push' : ''}`);
      lines.push(moved.shared.length ? `changed on both sides: ${filesText(moved.shared)}` : 'no file is changed on both sides: no base merge needed');
    }
  } catch (error) {
    lines.push(`note: base movement unreadable (${error.message})`);
  }
}

/** Blockers that need no review read: Draft, a missing CI run, merge conflicts. */
function judgeBlockers({ pr, facts, now, contexts, isOptionalCheck }, s) {
  const { lines, reasons } = s;
  const pushes = () => facts.pushLog;
  // A Draft skips the guarded CI jobs, so its green checks prove nothing: never DONE, whatever the checks say.
  if (pr.isDraft) {
    s.failed = true;
    reasons.push('PR is still Draft');
    lines.push(`blocker: PR is still Draft; run board.mjs done ISSUE`);
  }
  // GitHub sometimes starts no pull_request run for a push and keeps the merge state UNKNOWN, so the wait never ends (#412). In a native stack
  // a conflict in a lower layer causes it. After 10 minutes without a pull_request or workflow_dispatch run on the head that is a blocker with its cause.
  // Nothing is dispatched: that costs Actions minutes, a person decides.
  if (!pr.isDraft && pr.mergeStateStatus === 'UNKNOWN' && contexts.nodes.every(isOptionalCheck) && now - headSetAt(pr, pushes()) > 10 * 60_000) {
    if (!facts.headRuns.some(run => ['pull_request', 'workflow_dispatch'].includes(run.event))) {
      s.failed = true;
      reasons.push('no CI run on the head');
      lines.push(`blocker: no pull_request run on the head 10 minutes after the push and the merge state is UNKNOWN; ${facts.stackOrderText
        ? `probably a conflict in a layer of the native stack locks it: ${facts.stackOrderText}`
        : 'push an empty commit or push the head again'}`);
    }
  }
  // Conflicts start no workflow, so the wait would never end; the fix is merging the base now.
  // UNKNOWN (GitHub computes the state late after a push) or BEHIND are no conflict.
  if (pr.mergeStateStatus === 'DIRTY' && !pr.isDraft) {
    s.failed = true;
    reasons.push('merge conflicts');
    lines.push(facts.conflictLine);
  }
}

/** A skip while Draft says nothing about the Ready head: wait for the run after Ready. */
function judgeDraftSkips({ pr, now, contexts, isOptionalCheck }, { lines, waiting }) {
  // A pull_request run skipped while the PR was still Draft (the usual `!draft` job guard) executed nothing, so it says
  // nothing about the Ready head. Ready normally starts a fresh run; until the workflow has an executed run created after
  // Ready, its path is missing, not green. An executed Draft run does not exempt the workflow (an unguarded job next to a
  // guarded one); a skip after Ready is a real optional skip. GitHub's required flag is no basis: it is false on
  // release branches for checks the project demands. A run triggered by opening as Draft or converting to Draft can land
  // just after a quick Ready, so that window counts as Draft too.
  // Only the latest Draft period counts: a skip from before the latest conversion belongs to an earlier period (a PR opened
  // Ready) and is no Draft skip.
  // ponytail: 10 s window for run creation lag after opening as Draft or a Draft conversion (a skipped Ready run inside it waits for the next push), and a Draft skip of an earlier period stays unseen
  // unless the latest period created a run too; replace both when the run's trigger action and the Draft history are readable.
  // It is judged over every run of the head, not only each job's decisive one: an executed push run of the same job from
  // before Ready must not hide the Draft skip. Only a run since Ready covers it: any run of the job, or an executed run of
  // the workflow.
  const readyEvent = Date.parse(pr.readyEvents?.nodes?.[0]?.createdAt);
  assert.ok(!pr.readyEvents?.nodes?.length || Number.isFinite(readyEvent), 'The Ready event time is unreadable');
  const convertEvent = Date.parse(pr.convertEvents?.nodes?.[0]?.createdAt);
  assert.ok(!pr.convertEvents?.nodes?.length || Number.isFinite(convertEvent), 'The Draft conversion time is unreadable');
  // Without a conversion, a Ready event means the PR was opened as Draft: its creation starts the Draft period like a conversion.
  const draftStart = convertEvent || (Number.isFinite(readyEvent) ? Date.parse(pr.createdAt) : -Infinity);
  assert.ok(!Number.isNaN(draftStart), 'The PR creation time is unreadable');
  const readyBoundary = Math.max(readyEvent, draftStart + 10_000);
  const runs = contexts.nodes.filter(check => orderable(check) && !isOptionalCheck(check));
  const startedAt = check => Date.parse(check.checkSuite?.createdAt);
  const flowOf = check => JSON.stringify([check.checkSuite?.app?.slug, check.checkSuite?.workflowRun?.workflow?.id]);
  // Inside the window only a skip is ambiguous (the Draft guard skips); a run that executed after the Ready event is a Ready run.
  const sinceReady = check => startedAt(check) >= (check.conclusion === 'SKIPPED' ? readyBoundary : readyEvent);
  const readyFlows = new Set(runs.filter(check => check.conclusion !== 'SKIPPED' && sinceReady(check)).map(flowOf));
  const readyJobs = new Set(runs.filter(sinceReady).map(jobKey));
  const draftSkipped = new Set();
  for (const check of runs.filter(check => Number.isFinite(readyEvent) && check.conclusion === 'SKIPPED' && check.checkSuite.workflowRun && !sinceReady(check)
    && !(startedAt(check) < convertEvent))) {
    const { event } = check.checkSuite.workflowRun;
    assert.equal(typeof event, 'string', `The event of skipped check ${check.name} is unreadable`);
    if (!['pull_request', 'pull_request_target'].includes(event)) continue;
    assert.ok(runs.filter(run => flowOf(run) === flowOf(check)).every(run => Number.isFinite(startedAt(run))), `A run of the workflow of skipped check ${check.name} has no readable start time`);
    if (!readyFlows.has(flowOf(check)) && !readyJobs.has(jobKey(check))) draftSkipped.add(check.name);
  }
  // A workflow whose trigger does not fire on Ready (pull_request_target or pull_request without ready_for_review, a path filter) leaves
  // its skip from opening as the only run. Ready starts a run within seconds, so none after this long is not coming: note it, stop waiting.
  // ponytail: fixed 10 minutes for every workflow; replace by the workflow's own trigger types when they are readable.
  for (const label of draftSkipped) {
    const text = `check ${label} was skipped while Draft; no run since Ready`;
    if (now - readyEvent > 10 * 60_000) lines.push(`note: ${text}; its workflow does not start on Ready`);
    else waiting.push({ text, since: Infinity });
  }
}

/** Open Sonar issues and failure notices of the head. */
function judgeSonar({ pr, facts, live, after }, s) {
  const { lines, reasons } = s;
  const { comments } = facts;
  const short = pr.headRefOid.slice(0, 7);
  for (const check of live.filter(check => check.checkSuite?.app?.slug === 'sonarqubecloud' && check.status === 'COMPLETED' && check.conclusion !== 'SKIPPED')) {
    const found = facts.sonar.get(check);
    if (found.error) throw found.error;
    const { total: open, lines: findings } = found;
    if (open === null) {
      lines.push('blocker: the Sonar issue count is unreadable: SONAR_TOKEN is not set and the SonarCloud check summary has no "N New issues"; set SONAR_TOKEN (docs/board/wait.md) and run done again');
      continue;
    }
    lines.push(`sonar: ${open} open issue${open === 1 ? '' : 's'}`, ...findings);
    if (open) {
      s.failed = true;
      reasons.push(`${open} open Sonar issue${open === 1 ? '' : 's'}`);
      lines.push(`blocker: ${reasons.at(-1)} on this head; fix them or justify each as a false positive`);
    }
    // A failure notice after the green check contradicts it (#570). It names no revision and is mostly about an older commit
    // whose analysis Sonar dropped (#2452): shown, never a blocker; the green check of the head decides.
    // ponytail: matched by time and wording; name the revision once Sonar puts it in the comment.
    const greenAt = Date.parse(check.completedAt);
    for (const notice of check.conclusion === 'SUCCESS' ? comments.filter(comment => isBot(comment.user) && /sonar/i.test(login(comment.user))
      && /analysis has failed/i.test(comment.body ?? '') && after(comment.created_at) && !(Date.parse(comment.created_at) < greenAt)) : []) {
      lines.push(`sonar: failure notice ${notice.html_url} came after the green check of head ${short}; it names no revision (likely an older commit), the green check stands`);
    }
  }
}

/** Bot traces: running summaries, 👀 reactions, review requests and the grace for reviewers that have not started. */
function judgeBotTraces({ pr, facts, live, now, graceMinutes, pushed, after, isOptional, isOptionalCheck }, { lines, waiting }) {
  const { comments } = facts;
  const short = pr.headRefOid.slice(0, 7);
  const pushes = () => facts.pushLog;
  const { reviewList, reactions } = facts;
  // Inline review comments and thread replies carry findings too.
  const { inline } = facts;
  // Results a bot can post: a review of this head, an issue comment, or a final (non-👀) reaction.
  // Codex runs a code and a security review side by side; the security result is its own comment under a
  // "Security Review" heading, so it ends only the security row. A final reaction ends every kind.
  const securityResult = body => /^#{1,6}\s.*Security Review/mi.test(body);
  const results = [...comments.map(comment => [login(comment.user), comment.updated_at, comment.id, securityResult(comment.body) ? 'security' : 'code']),
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => [login(review.user), review.submitted_at, null, 'code']),
    ...reactions.filter(reaction => reaction.content !== 'eyes').map(reaction => [login(reaction.user), reaction.created_at, null, 'any'])];
  // The summary's own later edits are no result, so its comment id is skipped.
  const answeredAfter = (author, since, own, kind) => results.some(([who, time, id, resultKind]) =>
    who === author && (id === null || id !== own) && Date.parse(time) > since && (resultKind === 'any' || resultKind === kind));
  for (const comment of comments.filter(comment => isBot(comment.user) && !isOptional(comment.user.login) && after(comment.updated_at))) {
    // Summary comments (Codex) name the head in a table row that says Running until the review completes;
    // a result the same bot posts elsewhere ends it too.
    for (const row of comment.body.split('\n').filter(row => row.includes('Running') && row.includes(short))) {
      const since = row.match(/datetime="([^"]+)"/)?.[1] ?? comment.updated_at;
      if (answeredAfter(login(comment.user), Date.parse(since), comment.id, /Security Review/i.test(row) ? 'security' : 'code')) continue;
      waiting.push({ text: `${login(comment.user)} running since ${since}`, since: Date.parse(since) });
    }
  }
  const activity = [...[...comments, ...inline].map(comment => [login(comment.user), comment.updated_at]),
    // A finishing review of the previous head never answers a trace on this one.
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => [login(review.user), review.submitted_at]),
    // 👍 is Codex's "no findings"; a later 👀 is its own open trace below.
    ...reactions.map(reaction => [login(reaction.user), reaction.created_at])];
  for (const reaction of reactions.filter(reaction => isBot(reaction.user) && after(reaction.created_at))) {
    // An optional reviewer's 👀 is shown and never awaited.
    if (isOptional(reaction.user.login)) {
      if (reaction.content === 'eyes') lines.push(`reaction ${login(reaction.user)} 👀 [optional reviewer, not awaited]`);
      continue;
    }
    // 👀 announces a review; a later comment, head review or final reaction by the same bot is its result.
    const answered = activity.some(([author, time]) => author === login(reaction.user) && Date.parse(time) > Date.parse(reaction.created_at));
    if (reaction.content === 'eyes' && !answered) waiting.push({ text: `${login(reaction.user)} reacted 👀`, since: Date.parse(reaction.created_at) });
  }
  // GitHub drops a request once the review arrives, so every remaining request is an outstanding review.
  assert.equal(pr.reviewRequests.nodes.length, pr.reviewRequests.totalCount, 'Not every review request is readable');
  const reviewerName = reviewer => reviewer?.login ?? reviewer?.name;
  for (const { requestedReviewer: reviewer } of pr.reviewRequests.nodes.filter(({ requestedReviewer }) => !(requestedReviewer?.__typename === 'Bot' && isOptional(requestedReviewer.login)))) {
    // A request added later starts its own clock.
    const requested = pr.requestEvents.nodes.filter(event => reviewerName(event.requestedReviewer) === reviewerName(reviewer))
      .map(event => Date.parse(event.createdAt));
    // Without its request time a new request would read as stalled; fail closed instead.
    assert.ok(requested.length || pr.requestEvents.nodes.length === pr.requestEvents.totalCount, 'Review request history is incomplete');
    waiting.push({ text: `review requested from ${reviewerName(reviewer) ?? 'an unreadable reviewer'}`, since: Math.max(pushed, ...requested) });
  }
  // Bots that start on "ready for review" (Codex) or on new commits leave their first trace a minute or two
  // later, often after CI is green. Until the grace has passed since the PR became ready or the head was
  // pushed, whichever is later, a missing trace is no answer yet. The grace ends as soon as one required bot has answered
  // for good on this head (a review, a comment other than an unfinished Running summary, a final reaction, or a limit notice
  // such as "usage limit" or "rate limited" in a comment or check): it has started, so more waiting for a silent one is guesswork.
  // ponytail: any one answering bot ends the grace for all of them, and github-actions comments (coverage reports) are no review; replace with a per-bot expectation when one exists.
  const limitNotice = /usage limit|rate.?limit/i;
  const answeredBot = [
    ...[...comments, ...inline].filter(comment => after(comment.updated_at)
      && !(comment.body ?? '').split('\n').some(row => row.includes('Running') && row.includes(short))).map(comment => comment.user),
    ...reviewList.filter(review => review.commit_id === pr.headRefOid).map(review => review.user),
    ...reactions.filter(reaction => reaction.content !== 'eyes' && after(reaction.created_at)).map(reaction => reaction.user),
  ].some(user => isBot(user) && login(user) !== 'github-actions' && !isOptional(user.login))
    || live.some(check => !isOptionalCheck(check) && check.checkSuite?.app?.slug !== 'github-actions' && limitNotice.test(`${check.title ?? ''} ${check.description ?? ''}`));
  const readyAt = Math.max(...[pr.createdAt, ...(pr.readyEvents?.nodes ?? []).map(event => event.createdAt)].filter(Boolean).map(Date.parse));
  if (graceMinutes > 0 && !answeredBot) {
    const graceFrom = Math.max(readyAt, pushed, headSetAt(pr, pushes()));
    if (now - graceFrom < graceMinutes * 60_000) {
      waiting.push({ text: `reviewers may still start until ${new Date(graceFrom + graceMinutes * 60_000).toISOString()}`, since: Infinity });
    }
  }
}

/** Reviews, comments, threads and change requests of the head; returns the stale change requests to dismiss. */
function reportReview({ pr, facts, after, isOptional, dismissStale }, { lines }) {
  const { comments, reviewList, inline } = facts;
  const short = pr.headRefOid.slice(0, 7);
  for (const review of reviewList.filter(review => review.commit_id === pr.headRefOid)) lines.push(`review ${login(review.user)} ${review.state} ${review.html_url}`);
  for (const comment of comments.filter(comment => after(comment.updated_at))) lines.push(`comment ${login(comment.user)} ${comment.html_url}`);
  for (const comment of inline.filter(comment => after(comment.updated_at))) lines.push(`inline ${login(comment.user)} ${comment.html_url}`);
  const { threads } = facts;
  lines.push(`unresolved threads: ${threads.length}`, ...threads.map(link => `thread ${link}`));
  // Mergeable is not merge-ready: a standing change request, a ruleset or conflicts still block the human.
  lines.push(`merge: ${pr.mergeStateStatus}, review decision: ${pr.reviewDecision ?? 'none'}`);
  assert.equal(pr.latestOpinionatedReviews.nodes.length, pr.latestOpinionatedReviews.totalCount, 'Not every review decision is readable');
  const dismissals = [];
  for (const review of pr.latestOpinionatedReviews.nodes.filter(review => review.state === 'CHANGES_REQUESTED')) {
    // GitHub's ruleset blocks the merge on a standing change request, so an optional reviewer's answered one (all threads resolved)
    // is dismissed on handoff only (the caller writes it); it is never re-requested. The review id comes from the REST list read above.
    const latest = dismissStale && !threads.length && isOptional(review.author?.login)
      && reviewList.findLast(item => login(item.user) === login(review.author) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(item.state));
    if (latest?.state === 'CHANGES_REQUESTED') {
      dismissals.push({ id: latest.id, message: `All review threads are resolved on head ${short}; the change request is stale.` });
      lines.push(`dismissed stale change request by ${login(review.author)}: all threads are resolved`);
    } else lines.push(`blocker: changes requested by ${login(review.author)}`);
  }
  return { threads, dismissals };
}

/**
 * The verdict for one look at the PR head: { done, failed, reasons, lines, pr, baseOnly?, comments?, threads?, dismissals? }.
 * `facts` (review-facts.mjs): pr, pushLog, baseMovement, headRuns, stackOrderText, conflictLine, comments, sonar (check -> { total, lines } or { error }),
 * reviewList, reactions, inline, threads; a field is read where the rules need it, in this order. `settings`: the PR base's awaitApps, optionalReviewers,
 * updateBranchChecks. `options`: stallMinutes, now, graceMinutes, dismissStale. `dismissals` are the stale change requests the caller is to dismiss.
 * The groups above add their findings to one state (lines, waiting, reasons, failed); the verdict is made here, in one place.
 */
export function judgeReview(facts, settings, { stallMinutes, now, graceMinutes, dismissStale = false }) {
  const { pr } = facts;
  const optional = optionalReviewers(settings); // a malformed "optionalReviewers" fails here, whatever the head looks like
  const isOptional = name => optional.has(reviewerKey(name));
  const lines = [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`];
  // Closed without merge ends the wait but is never a delivery.
  if (pr.state !== 'OPEN') return { done: true, failed: pr.state === 'CLOSED', reasons: ['PR closed without merge'], lines, pr };
  const pushed = headPushed(pr);
  const ctx = { facts, settings, pr, now, graceMinutes, dismissStale, pushed, isOptional, commit: pr.commits.nodes[0].commit,
    isOptionalCheck: check => isOptional(check.checkSuite?.app?.slug ?? check.creator?.login),
    after: time => Date.parse(time) >= pushed };
  const s = { lines, waiting: [], reasons: [], baseReasons: new Set(), failed: false }; // reasons: short causes for the FAILED line; the detail lines stay in `lines`
  const stalled = since => now - since > stallMinutes * 60_000; // false for Infinity
  Object.assign(ctx, judgeChecks(ctx, s));
  judgeSuites(ctx, s);
  judgeProgress(ctx, s);
  judgeBlockers(ctx, s);
  // A known CI failure or conflict is the verdict; later review reads must not turn it into ERROR.
  if (s.failed) return { done: true, failed: true, reasons: s.reasons, lines, pr, baseOnly: s.reasons.every(reason => s.baseReasons.has(reason)) };
  judgeDraftSkips(ctx, s);
  judgeSonar(ctx, s);
  judgeBotTraces(ctx, s);
  const { threads, dismissals } = reportReview(ctx, s);
  // ponytail: one fixed "usual duration" for every reviewer; replace when earlier review durations are readable.
  for (const entry of s.waiting.filter(entry => stalled(entry.since))) lines.push(`stalled: ${entry.text}`);
  const pending = s.waiting.filter(entry => !stalled(entry.since));
  for (const entry of pending) lines.push(`waiting: ${entry.text}`);
  // A known failure ends the wait at once: the fix starts now, whatever else is still running.
  return { done: s.failed || !pending.length, failed: s.failed, reasons: s.reasons, lines, pr, comments: facts.comments, threads, dismissals };
}
