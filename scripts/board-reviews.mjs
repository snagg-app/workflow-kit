// The review gate: one look at a PR head (CI, bots, threads, change requests) and the project settings it reads from the PR's base branch.
// A factory over `env` (project, github adapter, the number and the stack helpers of the caller), so tests and other commands can import it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** The SonarCloud check links the analysis of another PR (sync PRs with one head, #640). */
export class SonarOtherPr extends Error {}

/** env: { project, owner, name, github, number, graceMinutes(), prQuery(suites), readStacks(pull), stackOrderText, conflictLine(pr) } */
export function createReviews(env) {
  const { project, owner, name, github } = env;
  const { graphql, rest, restAll } = github;

  /** Links of unresolved review threads across every page, including findings on earlier heads. */
  function unresolvedThreads(prNumber = env.number, firstPage) {
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
  const login = user => user?.login?.replace(/\[bot\]$/, '');
  const isBot = user => user?.type === 'Bot';
  // The review gate (`reviews`, so `wait`, `handoff` and `merge`) takes these settings from the target branch of the PR as it is now, never from
  // the checkout: a stale checkout would apply rules the branch has since changed (#448).
  // ponytail: one REST read per look, no cache; cache by base commit if the REST quota ever gets tight.
  let gate = project;
  let optional; // the optionalReviewers set of `gate`, built on first use and dropped with every new `gate`
  function useBaseSettings(pr) {
    assert.ok(pr.baseRefName, 'The PR base is not readable');
    const file = rest(`repos/${project.repository}/contents/.github/workflow-project.json?ref=${encodeURIComponent(pr.baseRefName)}`);
    assert.equal(file?.encoding, 'base64', `.github/workflow-project.json on ${pr.baseRefName} is unreadable`);
    const base = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    gate = { ...project, ...Object.fromEntries(['awaitApps', 'optionalReviewers', 'updateBranchChecks', 'doneBaseMerge'].map(key => [key, base[key]])) };
    optional = undefined;
  }
  // "optionalReviewers" lists bot logins or app slugs whose traces are shown but never awaited, stalled or counted as red
  // (a review bot on a free plan that is rate limited most of the time). Their open threads and change requests still block; `handoff` dismisses a change request once all threads are resolved.
  const reviewerKey = name => name?.trim().toLowerCase().replace(/^(@|app\/)/, '').replace(/\[bot\]$/, '');
  // Read on use, so a malformed list is an ERROR of the review commands, not a crash of every command.
  const optionalReviewers = () => {
    const list = gate.optionalReviewers === undefined ? [] : gate.optionalReviewers; // only a missing field is allowed; null is malformed
    assert.ok(Array.isArray(list) && list.every(name => typeof name === 'string' && name.trim()),
      'optionalReviewers must be a list of non-empty bot logins or app slugs');
    return new Set(list.map(reviewerKey));
  };
  // "updateBranchChecks" lists checks whose failure only asks for the base to be merged into the PR branch (#383, e.g. a retarget restart check): `merge` does that itself.
  const updateBranchChecks = () => {
    const list = gate.updateBranchChecks === undefined ? [] : gate.updateBranchChecks;
    assert.ok(Array.isArray(list) && list.every(name => typeof name === 'string' && name.trim()), 'updateBranchChecks must be a list of non-empty check names');
    return new Set(list);
  };
  const isOptional = name => (optional ??= optionalReviewers()).has(reviewerKey(name));
  const isOptionalCheck = check => isOptional(check.checkSuite?.app?.slug ?? check.creator?.login);
  const passed = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

  const readPr = prNumber => {
    for (const suites of [30, 100]) {
      const pr = graphql(env.prQuery(suites), { owner, name, number: prNumber }).repository.pullRequest;
      const commit = pr?.commits?.nodes?.[0]?.commit;
      if (suites === 100 || !(commit?.checkSuites?.totalCount > commit.checkSuites.nodes.length)) return pr;
    }
  };
  // The token goes only to these hosts, whatever URL a check run names.
  const sonarHosts = ['https://sonarcloud.io', 'https://sonarqube.us'];
  const sonarListed = 10; // findings printed per analysis; the count says how many more
  /**
   * OPEN and CONFIRMED issues of the pull request analysis a SonarCloud check run points at. The anonymous API reports 0
   * for private projects, so a failed read throws (never "clean"). Without a token the count comes from the check
   * run's summary instead (total null when unreadable). Sync like the other reads: the request runs in a child process.
   */
  function sonarIssues(detailsUrl, prNumber, summary) {
    const target = new URL(detailsUrl ?? 'invalid:');
    const key = target.searchParams.get('id');
    const unlinked = `The SonarCloud check does not link PR #${prNumber}'s analysis (${detailsUrl}); open issues are unreadable`;
    assert.ok(sonarHosts.includes(target.origin) && key && target.searchParams.get('pullRequest'), unlinked);
    // Sync PRs with the same head share one analysis, and it links one of them (#640): `merge` answers with a branch update.
    if (target.searchParams.get('pullRequest') !== String(prNumber)) throw new SonarOtherPr(unlinked);
    if (!process.env.SONAR_TOKEN) {
      // The check run's own summary names the count ("[0 New issues](…)"); only that is a readable number, else total is null.
      const count = /\[(\d+) New issues?\]/.exec(summary ?? '')?.[1];
      return { total: count === undefined ? null : Number(count), lines: count > 0 ? [`sonar: list them with SONAR_TOKEN set, or at ${target.href}`] : [] };
    }
    const api = new URL('/api/issues/search', target.origin);
    api.search = new URLSearchParams({ componentKeys: key, pullRequest: String(prNumber), issueStatuses: 'OPEN,CONFIRMED', ps: String(sonarListed) });
    const body = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const r = await fetch(process.argv[1], { headers: { Authorization: 'Bearer ' + process.env.SONAR_TOKEN } });
       if (!r.ok) throw new Error('Sonar API answered ' + r.status);
       process.stdout.write(await r.text());`, api.href], { encoding: 'utf8', maxBuffer: 16 << 20 });
    const { total, issues } = JSON.parse(body);
    assert.ok(Number.isSafeInteger(total) && total >= 0 && Array.isArray(issues), 'Sonar issue count is unreadable');
    // One line each, so a finding is fixable without a script of its own. The message quotes code of the PR: no control characters.
    const lines = issues.slice(0, sonarListed).map(({ rule, component, line, message }) => {
      const file = String(component ?? '').replace(`${key}:`, '');
      return `sonar: ${rule} ${file}${line ? `:${line}` : ''} ${String(message ?? '').replace(/\p{Cc}+/gu, ' ')}`;
    });
    if (total > lines.length) lines.push(`sonar: … ${total - lines.length} more`);
    return { total, lines };
  }

  function pushLog(pr) {
    const log = rest(`repos/${project.repository}/activity?ref=${encodeURIComponent(`refs/heads/${pr.headRefName}`)}&per_page=100`);
    assert.ok(Array.isArray(log), 'Push log is unreadable');
    return log;
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
  function headSetAt(pr, log = pushLog(pr)) {
    // The same commit can be pushed twice (X, Y, X again); the latest push counts, whatever the order.
    const pushes = log.filter(entry => entry.after === pr.headRefOid);
    assert.ok(pushes.length, 'Push time of the head is not readable; retry the read');
    const time = Math.max(...pushes.map(entry => Date.parse(entry.timestamp)));
    assert.ok(Number.isFinite(time), 'Push time of the head is unreadable');
    return time;
  }

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
  const filesText = files => files.slice(0, 10).join(', ') + (files.length > 10 ? `, and ${files.length - 10} more` : '');

  /** One look at the PR head: done or still waiting, and whether CI failed; read failures throw (`dismissStale`, handoff only, is the one write). `threadsOf` reads the unresolved threads (wait reuses the last answer). */
  function reviews(stallMinutes = 20, now = Date.now(), prNumber = env.number, pr = readPr(prNumber), graceMinutes = env.graceMinutes(), threadsOf = current => unresolvedThreads(current.number, current.reviewThreads), dismissStale = false) {
    useBaseSettings(pr);
    isOptional(); // a malformed "optionalReviewers" fails here, whatever the head looks like
    const baseChecks = updateBranchChecks(), baseReasons = new Set();
    const lines = [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`];
    // Closed without merge ends the wait but is never a delivery.
    if (pr.state !== 'OPEN') return { done: true, failed: pr.state === 'CLOSED', reasons: ['PR closed without merge'], lines, pr };
    const { commit } = pr.commits.nodes[0];
    assert.equal(commit.oid, pr.headRefOid, 'Head commit not readable');
    // CI starts on push, so the first check suite dates the push. Before that the commit date is a
    // conservative lower bound: it can only add traces, never hide one.
    assert.equal(commit.checkSuites.nodes.length, commit.checkSuites.totalCount, 'Not every check suite is readable');
    // A bot sees the head through the same push event that opens the suites, so no trace predates them.
    const suites = commit.checkSuites.nodes.map(suite => Date.parse(suite.createdAt));
    const pushed = suites.length ? Math.min(...suites) : Date.parse(commit.committedDate);
    const after = time => Date.parse(time) >= pushed;
    let log;
    const pushes = () => log ??= pushLog(pr);
    const stalled = since => now - since > stallMinutes * 60_000; // false for Infinity
    const waiting = [];
    let failed = false;
    const reasons = []; // short causes for the FAILED line; the detail lines stay in `lines`
    const contexts = commit.statusCheckRollup?.contexts ?? { totalCount: 0, nodes: [] };
    assert.equal(contexts.nodes.length, contexts.totalCount, 'Not every check is readable');
    // The usual Draft-then-Ready sequence starts a second workflow run on the same commit and cancels the first, so the
    // first run's jobs are superseded. A job (app, workflow id, name) is superseded only by the same job of a NEWER run,
    // never by another job of its own run: two jobs of one run that share a display name both count, and so does a
    // newest run that is cancelled. The workflow is told apart by its id (two files can share a display name). A check
    // without a run or suite id cannot be ordered and stays as it is.
    const runOf = check => check.checkSuite?.workflowRun?.databaseId ?? check.checkSuite?.databaseId;
    const jobKey = check => JSON.stringify([check.checkSuite?.app?.slug, check.checkSuite?.workflowRun?.workflow?.id, check.name]);
    const orderable = check => check.__typename === 'CheckRun' && Number.isSafeInteger(runOf(check));
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
        failed = true;
        const asks = baseChecks.has(label);
        reasons.push(`check ${label} ${result}${asks ? ` asks for the base: run board.mjs merge ${pr.number} or merge the base and push` : ''}`);
        if (asks) baseReasons.add(reasons.at(-1));
      }
      // Descriptions carry results such as "Review rate limited" behind a green state.
      lines.push(`check ${label}: ${result}${check.title || check.description ? ` (${check.title || check.description})` : ''}`);
    }
    if (contexts.nodes.every(isOptionalCheck)) waiting.push({ text: 'first CI check', since: Infinity });
    // An Actions suite without runs is a triggered workflow about to report. Other apps (Sonar, CodeRabbit,
    // Renovate …) open a suite on every push and often never run it, so they count only when the project
    // lists them in "awaitApps" (analyzers such as SonarCloud create their run only when finished). Both may stall.
    const awaited = new Set(['github-actions', ...gate.awaitApps ?? []].filter(slug => !isOptional(slug)));
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
        failed = true;
        reasons.push(`check suite ${suite.app.slug} ${suite.conclusion}`);
        lines.push(`check suite ${suite.app.slug}: ${suite.conclusion}`);
      }
    }
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
      const moved = baseMovement(pr);
      if (moved) {
        lines.push(`base moved: ${moved.behind} commits since merge-base (${pr.baseRefName})${moved.shared.length ? '; merge it once before the next push' : ''}`);
        lines.push(moved.shared.length ? `changed on both sides: ${filesText(moved.shared)}` : 'no file is changed on both sides: no base merge needed');
      }
    } catch (error) {
      lines.push(`note: base movement unreadable (${error.message})`);
    }
    // A Draft skips the guarded CI jobs, so its green checks prove nothing: never DONE, whatever the checks say.
    if (pr.isDraft) {
      failed = true;
      reasons.push('PR is still Draft');
      lines.push(`blocker: PR is still Draft; run board.mjs done ISSUE`);
    }
    // GitHub sometimes starts no pull_request run for a push and keeps the merge state UNKNOWN, so the wait never ends (#412). In a native stack
    // a conflict in a lower layer causes it. After 10 minutes without a pull_request or workflow_dispatch run on the head that is a blocker with its cause.
    // Nothing is dispatched: that costs Actions minutes, a person decides.
    if (!pr.isDraft && pr.mergeStateStatus === 'UNKNOWN' && contexts.nodes.every(isOptionalCheck) && now - headSetAt(pr, pushes()) > 10 * 60_000) {
      const headRuns = rest(`repos/${project.repository}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`).workflow_runs;
      assert.ok(Array.isArray(headRuns), 'The workflow runs of the head are unreadable');
      if (!headRuns.some(run => ['pull_request', 'workflow_dispatch'].includes(run.event))) {
        failed = true;
        reasons.push('no CI run on the head');
        lines.push(`blocker: no pull_request run on the head 10 minutes after the push and the merge state is UNKNOWN; ${env.readStacks(pr.number).length
          ? `probably a conflict in a layer of the native stack locks it: ${env.stackOrderText}`
          : 'push an empty commit or push the head again'}`);
      }
    }
    // Conflicts start no workflow, so the wait would never end; the fix is merging the base now.
    // UNKNOWN (GitHub computes the state late after a push) or BEHIND are no conflict.
    if (pr.mergeStateStatus === 'DIRTY' && !pr.isDraft) {
      failed = true;
      reasons.push('merge conflicts');
      lines.push(env.conflictLine(pr));
    }
    // A known CI failure or conflict is the verdict; later review reads must not turn it into ERROR.
    if (failed) return { done: true, failed, reasons, lines, pr, baseOnly: reasons.every(reason => baseReasons.has(reason)) };
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
    // The quality gate judges new conditions only, so a green SonarCloud check can sit on open issues. Count them once the analysis is final; a skipped check ran no analysis.
    const comments = restAll(`repos/${project.repository}/issues/${pr.number}/comments`);
    const short = pr.headRefOid.slice(0, 7);
    for (const check of live.filter(check => check.checkSuite?.app?.slug === 'sonarqubecloud' && check.status === 'COMPLETED' && check.conclusion !== 'SKIPPED')) {
      const { total: open, lines: found } = sonarIssues(check.detailsUrl, pr.number, check.summary);
      if (open === null) {
        lines.push('blocker: the Sonar issue count is unreadable: SONAR_TOKEN is not set and the SonarCloud check summary has no "N New issues"; set SONAR_TOKEN (README, Board commands) and run done again');
        continue;
      }
      lines.push(`sonar: ${open} open issue${open === 1 ? '' : 's'}`, ...found);
      if (open) {
        failed = true;
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
    const reviewList = restAll(`repos/${project.repository}/pulls/${pr.number}/reviews`);
    // Bots acknowledge "@bot review" comments with a reaction on that comment, not on the PR.
    const reactions = [...restAll(`repos/${project.repository}/issues/${pr.number}/reactions`),
      ...comments.filter(comment => after(comment.created_at) && /@[\w-]+(\[bot\])?\s+review\b/i.test(comment.body))
        .flatMap(comment => restAll(`repos/${project.repository}/issues/comments/${comment.id}/reactions`))];
    // Inline review comments and thread replies carry findings too.
    const inline = restAll(`repos/${project.repository}/pulls/${pr.number}/comments`);
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
    for (const review of reviewList.filter(review => review.commit_id === pr.headRefOid)) lines.push(`review ${login(review.user)} ${review.state} ${review.html_url}`);
    for (const comment of comments.filter(comment => after(comment.updated_at))) lines.push(`comment ${login(comment.user)} ${comment.html_url}`);
    for (const comment of inline.filter(comment => after(comment.updated_at))) lines.push(`inline ${login(comment.user)} ${comment.html_url}`);
    const threads = threadsOf(pr);
    lines.push(`unresolved threads: ${threads.length}`, ...threads.map(link => `thread ${link}`));
    // Mergeable is not merge-ready: a standing change request, a ruleset or conflicts still block the human.
    lines.push(`merge: ${pr.mergeStateStatus}, review decision: ${pr.reviewDecision ?? 'none'}`);
    assert.equal(pr.latestOpinionatedReviews.nodes.length, pr.latestOpinionatedReviews.totalCount, 'Not every review decision is readable');
    for (const review of pr.latestOpinionatedReviews.nodes.filter(review => review.state === 'CHANGES_REQUESTED')) {
      // GitHub's ruleset blocks the merge on a standing change request, so an optional reviewer's answered one (all threads resolved)
      // is dismissed here, on handoff only; it is never re-requested. The review id comes from the REST list read above.
      const latest = dismissStale && !threads.length && isOptional(review.author?.login)
        && reviewList.findLast(item => login(item.user) === login(review.author) && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(item.state));
      if (latest?.state === 'CHANGES_REQUESTED') {
        github.run(['api', `repos/${project.repository}/pulls/${pr.number}/reviews/${latest.id}/dismissals`, '-X', 'PUT', '-f',
          `message=All review threads are resolved on head ${short}; the change request is stale.`], { stdio: 'pipe' });
        lines.push(`dismissed stale change request by ${login(review.author)}: all threads are resolved`);
      } else lines.push(`blocker: changes requested by ${login(review.author)}`);
    }
    // ponytail: one fixed "usual duration" for every reviewer; replace when earlier review durations are readable.
    for (const entry of waiting.filter(entry => stalled(entry.since))) lines.push(`stalled: ${entry.text}`);
    const pending = waiting.filter(entry => !stalled(entry.since));
    for (const entry of pending) lines.push(`waiting: ${entry.text}`);
    // A known failure ends the wait at once: the fix starts now, whatever else is still running.
    return { done: failed || !pending.length, failed, reasons, lines, pr, comments, threads };
  }

  return { reviews, readPr, useBaseSettings, isOptional, unresolvedThreads, baseMovement, filesText, baseSettings: () => gate };
}
