// `handoff` and `ready`: the checks before an issue reaches Human review.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';
import { shared } from './board-args.mjs';
import { failed, isResult, result } from './board-result.mjs';

/** What `board.mjs help` and the parser know about the commands; `run` names the function this module returns. */
export const specs = [
  { name: 'handoff', run: 'handoff', hidden: true, writes: true, words: [{ name: 'ISSUE', kind: 'number' }, { name: 'PR', kind: 'digits' }],
    summary: 'The handoff gate: Human review once the PR, its checks, reviews and the handoff comment are in order. `done` runs it.',
    flags: { '--stall': shared.stall, '--grace': shared.grace, '--interval': { value: 'SECONDS', kind: 'seconds60', help: 'A fixed pause between reads, 0 to 60.' }, '--refs': shared.refs } },
  { name: 'ready', run: 'ready', hidden: true, writes: true, usage: 'ready PR SHA|--local [--attempts N] [--interval SECONDS]', words: [{ name: 'PR', kind: 'number' }, { name: 'SHA', kind: 'sha', optional: true }],
    summary: 'Marks the Draft PR ready for exactly the pushed head. `done` runs it.',
    flags: { '--local': { help: 'Take the head from the checkout.' }, '--attempts': { value: 'N', kind: 'attempts', help: 'Reads of the PR head, 1 to 100 (default 6).' },
      '--interval': { value: 'SECONDS', kind: 'seconds', help: 'Pause between reads (default 5).' } },
    check: args => {
      if (args.flag('--local') === (args.words[1] !== undefined)) return `ready needs a commit id of 7 to 40 characters (git rev-parse HEAD) or --local, not ${args.words[1] ? `"${args.words[1]}" with --local` : 'nothing'}`;
      // Polling must end: two loops (stale head before the write, read-back after it), each sleeping up to (attempts - 1) times, at most half an hour in total.
      if (2 * args.number('--attempts', 6) * args.number('--interval', 5) > 1800) return 'ready: --attempts times --interval is too long (at most 900 seconds of pauses)';
    } },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createHandoff(env) {
  const { args, graphql, handoffHeading, isSpec, issueProject, name, number, numberOption, owner, project, projectItem, projectStatus, readIssue, rest, sleep, specRefusal, stallOption, state, statuses, step, text, texts } = env;
  const { check, connectedIssues, isPartialPr, mayStart, readPr, reviewOutcome, reviews, set } = env.later;

  /**
   * Everything the issue side of the handoff still lacks (readiness, review status, assignment) on the
   * supplied issue snapshot, or the result of check() when that already stops (BLOCKED, UNKNOWN).
   * `reviewedHead`: the PR head the proof was gathered for; a stacked layer must still be that head when this reads it.
   */
  function handoffIssueReasons(issue, viewer, reviewedHead, currentPrNumber) {
    const judged = check(issue, undefined, currentPrNumber);
    if (!mayStart(judged)) return judged;
    step(judged);
    assert.ok(issue.id, 'Issue identity is unreadable');
    const status = projectStatus(issue);
    const reasons = [];
    // An upper layer may be handed off before the base is merged, but only as a layer on that base.
    // A merged base leaves a plain PR on the trunk; it still has to come from this repository and target that trunk.
    if (state.stackedOn) {
      const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){baseRefName headRefOid isCrossRepository headRepository{nameWithOwner}}}}`, { owner, name, number: Number(state.value) }).repository;
      if (reviewedHead && pr?.headRefOid !== reviewedHead) reasons.push(`PR #${state.value} changed its head from ${reviewedHead.slice(0, 7)} during handoff; read it again`);
      if (pr?.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) reasons.push(`PR #${state.value} comes from a fork or another repository: stacks stay inside ${project.repository}`);
      if (state.stackedOn.state === 'MERGED') {
        if (pr?.baseRefName !== state.stackedOn.baseRefName) reasons.push(`PR #${state.stackedOn.number} is merged into ${state.stackedOn.baseRefName}: PR #${state.value} must target it, not ${pr?.baseRefName}`);
      } else {
        // An aligned branch chain is no stack: GitHub must list both PRs in one open stack (the read-back of the docs, step 2).
        const stacks = rest(`repos/${project.repository}/stacks?pull_request=${Number(state.value)}`);
        // The base PR may sit anywhere below this PR; the head and target checks below concern the layer directly under it.
        const base = { number: state.stackedOn.number, ref: state.stackedOn.headRefName, sha: state.stackedOn.headRefOid };
        let lower; // {number, ref, sha} of the layer directly under this PR; the base PR itself keeps its own read
        if (Array.isArray(stacks) && stacks.length === 1 && stacks[0].open === true && Array.isArray(stacks[0].pull_requests)) {
          const members = stacks[0].pull_requests;
          const baseIndex = members.findIndex(member => member.number === state.stackedOn.number);
          const ownIndex = members.findIndex(member => member.number === Number(state.value));
          const under = members[ownIndex - 1];
          if (baseIndex >= 0 && ownIndex > baseIndex) {
            if (under.number === base.number) lower = base;
            else if (typeof under.head?.ref === 'string' && typeof under.head.sha === 'string') lower = { number: under.number, ref: under.head.ref, sha: under.head.sha };
          }
        }
        if (!lower) {
          reasons.push(`PR #${state.value} is not above PR #${state.stackedOn.number} in one open native stack (GET repos/${project.repository}/stacks?pull_request=${state.value}); link it (docs/CONTRIBUTING.md#stacked-pull-requests) or stop`);
        }
        const { number: lowerNumber, ref: lowerRef, sha: lowerSha } = lower ?? base;
        // Proof of the upper head only counts when that head contains the lower PR's current head (a later push below leaves the branch name unchanged).
        if (!reasons.length && pr?.baseRefName === lowerRef) {
          const { status } = rest(`repos/${project.repository}/compare/${lowerSha}...${pr.headRefOid}`);
          if (!['ahead', 'identical'].includes(status)) reasons.push(`PR #${state.value} does not contain the current head ${lowerSha.slice(0, 7)} of PR #${lowerNumber} (compare says ${status}): rebase onto it and push with the lease`);
        }
        if (pr?.baseRefName !== lowerRef) reasons.push(`the open predecessor PR #${lowerNumber} is not merged: PR #${state.value} must target its branch ${lowerRef}, not ${pr?.baseRefName}`);
      }
    }
    if (![statuses.automatedReview, statuses.humanReview].includes(status)) reasons.push(`status is ${status ?? 'unset'}: when the work is done, run board.mjs done ISSUE`);
    if (!issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase())) {
      reasons.push(`the issue is not assigned to the authenticated driver: gh issue edit ${issue.number} --repo ${issueProject.repository} --add-assignee "@me"`);
    }
    return reasons;
  }

  /** The recheck before the write: nothing when the issue side holds, otherwise the result that stops the handoff. */
  function handoffIssue(issue, viewer, reviewedHead, currentPrNumber) {
    const reasons = handoffIssueReasons(issue, viewer, reviewedHead, currentPrNumber);
    return isResult(reasons) ? reasons : reasons.length ? failed(reasons) : undefined;
  }

  /**
   * The driver's handoff comment: a "## " heading with texts.handoff and a "Head: <SHA>" line in a PR comment by the authenticated
   * user. The comment names the head it is about, so a new head asks for a new comment however (and whenever) the push
   * happened, which no timestamp reliably tells. With several matching comments the newest counts.
   */
  const findHandoffComment = (comments, viewer, headRefOid) => comments.findLast(comment => comment.user?.login?.toLowerCase() === viewer.login.toLowerCase()
    && handoffHeading.test(comment.body ?? '') && new RegExp(`^Head:\\s*${headRefOid.slice(0, 7)}`, 'im').test(comment.body ?? ''));
  const headingText = part => text(part.match(/^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/)?.[1] ?? '');

  /** A quoted template is no section: drop quotes (innermost first, so nesting works) before searching. */
  function withoutQuotes(html) {
    let unquoted = html;
    for (let previous; previous !== unquoted;) { previous = unquoted; unquoted = unquoted.replace(/<blockquote[\s>](?:(?!<blockquote[\s>])[\s\S])*?<\/blockquote>/g, ''); }
    return unquoted;
  }

  /**
   * Why the PR body, as GitHub renders it, does not carry the self-review the project asks for: the project file's
   * "selfReview" lists the checks (for example "ponytail-review", "code-review") that the section texts.selfReview (a heading of
   * any level; its sub-headings belong to it) must name. Whether a check was good is not judged. Without the field nothing is asked.
   */
  // ponytail: a name counts when the section mentions it, the section is not proof the check ran; replace when a check leaves a trace.
  const selfReviewChecks = () => project.selfReview;

  function selfReviewReasons(bodyHtml, checks) {
    if (!checks.length) return [];
    assert.equal(typeof bodyHtml, 'string', 'The rendered PR body is unreadable');
    const parts = withoutQuotes(bodyHtml).split(/(?=<h[1-6][\s>])/), level = part => Number(/^<h([1-6])[\s>]/.exec(part)?.[1]);
    const start = parts.findIndex(part => level(part) && headingText(part) === texts.selfReview);
    if (start < 0) return [`the PR body needs a "## ${texts.selfReview}" section that names ${checks.join(', ')} (docs/CONTRIBUTING.md#review-loop, step 1)`];
    let end = start + 1;
    while (end < parts.length && level(parts[end]) > level(parts[start])) end++;
    const section = text(parts.slice(start, end).join(''));
    const missing = checks.filter(check => !new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_-])${RegExp.escape(check.trim())}(?![\\p{L}\\p{M}\\p{N}_-])`, 'iu').test(section));
    return missing.length ? [`the "${texts.selfReview}" section of the PR body does not name: ${missing.join(', ')}`] : [];
  }

  /**
   * The PR gate handoff and merge share: an open non-draft PR whose CI and every traced review have finished, without
   * blockers or open threads, and with a determined merge state. Prints the verdict and sets the exit code; returns the
   * review result only when it holds. Its own reasons include the self-review section of the PR body ("selfReview" of the project file).
   * `extra` adds the caller's own further reasons (it runs only once the shared gate holds).
   * `prior` are reasons the caller found before (the issue side of handoff): they are listed with the PR's, in one run.
   * `reviewed` is only merge's just-returned poll proof; a branch update replaces it, while handoff always reads a fresh gate.
   * GitHub computes the merge state late: an undetermined one is read again a few times (`--interval` seconds apart, at
   * 1 point each) before it counts as waiting.
   */
  const mergeStates = ['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'], mergeReads = 4;
  function finishedPr(prNumber, action, expectedHead, extra = () => [], prior = [], reviewed) {
    const checks = selfReviewChecks();
    const pr = reviewed?.pr ?? readPr(prNumber);
    if (checks.length) assert.equal(typeof pr.bodyHTML, 'string', 'The rendered PR body is unreadable');
    assert.equal(typeof pr.isDraft, 'boolean', 'PR draft state is unreadable');
    // Somebody else merged it while merge waited (#556): the goal is reached, so merge goes on with its steps after a merge. Handoff still needs an open PR.
    if (action === 'merge' && pr.state === 'MERGED') return { pr, merged: true, lines: [] };
    if (pr.state !== 'OPEN' || pr.isDraft) return failed([...prior, `${action} needs an open non-draft PR`]);
    const review = reviewed ?? reviews(stallOption(), Date.now(), prNumber, pr, undefined, undefined, action === 'handoff');
    // The lines of the read explain a stop; when the gate holds they are details.
    const explained = outcome => ({ ...outcome, blockers: [...review.lines.filter(line => line.startsWith('blocker: ')).map(line => line.slice('blocker: '.length)), ...outcome.blockers],
      notes: [...review.lines.filter(line => !line.startsWith('blocker: ')), ...outcome.notes] });
    if (!review.done || review.failed) return reviewOutcome(review, { prior });
    if (expectedHead) assert.equal(review.pr.headRefOid, expectedHead, `PR head changed during ${action}`);
    const reasons = [...prior];
    if (review.lines.some(line => line.startsWith('blocker:') || /^unresolved threads: [1-9]/.test(line))) {
      reasons.push(`resolve review blockers and threads before ${action}`);
    }
    reasons.push(...selfReviewReasons(review.pr.bodyHTML, checks), ...extra(review));
    // Handoff and merge alike: a PR text edited after the handoff must not close a spec either.
    for (const specNumber of closedSpecs(review.pr.body)) reasons.push(specRefusal(specNumber, `the text of PR #${prNumber} closes it; write "Refs #${specNumber}" instead`));
    const undetermined = state => !state || state === 'UNKNOWN';
    let state = review.pr.mergeStateStatus;
    // merge looks longer than handoff (#721): about a minute at the default 3 s pause.
    for (let read = 1; undetermined(state) && read < (action === 'merge' ? 20 : mergeReads); read++) {
      sleep(numberOption('--interval', 3));
      const fresh = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){headRefOid mergeStateStatus}}}`, { owner, name, number: prNumber }).repository.pullRequest;
      assert.equal(fresh?.headRefOid, review.pr.headRefOid, `PR head changed during ${action}`);
      state = fresh.mergeStateStatus;
    }
    // The snapshot's own DIRTY is already a blocker line of reviews(); a DIRTY that GitHub computed during the re-reads is new.
    if (state === 'DIRTY' && review.pr.mergeStateStatus !== 'DIRTY') reasons.push('merge conflicts: resolve them before ' + action);
    if (!mergeStates.includes(state)) {
      if (!reasons.length) return explained(result('waiting', 'WAITING', { notes: ['waiting: PR mergeability is not determined'] }));
      if (undetermined(state)) reasons.push('PR mergeability is not determined (GitHub is still computing it): run again in a minute');
    }
    if (reasons.length) return explained(failed(reasons));
    return review;
  }

  /**
   * The issues of this repository that the PR text closes with a keyword ("Closes #N", "Fixes owner/repo#N") and that carry the spec label.
   * ponytail: only the first number after a keyword counts ("Closes #5, #6" names #5); a link or a native closing link made by hand is not read.
   */
  function closedSpecs(prText) {
    const numbers = new Set();
    for (const [, repository, issueNumber] of String(prText ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+((?:[\w.-]+\/[\w.-]+)?)#(\d+)/gi)) {
      if (!repository || repository.toLowerCase() === project.repository.toLowerCase()) numbers.add(Number(issueNumber));
    }
    return [...numbers].filter(issueNumber => {
      try { return isSpec({ labels: { nodes: rest(`repos/${project.repository}/issues/${issueNumber}`).labels } }); } catch (error) {
        if (/\b404\b|Not Found/.test(String(error.stderr))) return false; // no such issue: nothing to protect
        throw error;
      }
    });
  }

  /** Read all PR gates and native links, optionally requiring the previously checked head; `prior`: see finishedPr. */
  function handoffPr(issueId, viewer, expectedHead, prior, partial) {
    return finishedPr(Number(state.value), 'handoff', expectedHead, ({ comments, pr }) => {
      const reasons = [];
      const comment = findHandoffComment(comments, viewer, pr.headRefOid);
      if (!comment) reasons.push(`no handoff comment for head ${pr.headRefOid.slice(0, 7)} on PR #${state.value}: write FILE (${texts.resultHint}, then "### Retro" with one list line per finding, or "- ${texts.noFindings}"; README: Handoff comment) and run board.mjs done ${number} FILE`);
      if (!partial && !connectedIssues(pr).has(issueId)) reasons.push(`PR #${state.value} is not natively linked to issue #${number}`);
      return reasons;
    }, prior);
  }

  /** Guard the Human review write with current PR proof followed by current issue prerequisites. */
  function handoff() {
    const issue = readIssue();
    const { viewer } = issue;
    assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
    // The issue side's reasons wait for the PR side's, so one run names everything that is missing.
    const currentPrNumber = Number(state.value);
    // A partial PR (see isPartialPr) has only the PR gate: no native link, and the issue's status and assignment are not its business, since the closing PR hands the issue off.
    // `--refs` is the same for a PR that only names the issue, whether or not another PR closes it (#510).
    const partial = args.flag('--refs') || isPartialPr(issue, currentPrNumber);
    const prior = partial ? [] : handoffIssueReasons(issue, viewer, undefined, currentPrNumber);
    if (isResult(prior)) return prior;
    const gate = handoffPr(issue.id, viewer, undefined, prior, partial);
    if (isResult(gate)) return gate;
    const { pr } = gate, data = { issue: number, pr: Number(state.value), head: pr.headRefOid };
    if (partial) return result('ok', 'HANDOFF', { headline: `HANDOFF #${number} PR #${state.value} head ${pr.headRefOid} (partial PR: the issue status stays, the closing PR hands it off)`, details: gate.lines, data });
    let stopped;
    if (!set('Status', statuses.humanReview, () => {
      stopped = handoffPr(issue.id, viewer, pr.headRefOid);
      if (isResult(stopped)) return;
      const current = readIssue();
      assert.equal(current?.id, issue.id, 'Issue identity changed during handoff');
      stopped = handoffIssue(current, viewer, pr.headRefOid, currentPrNumber);
      return stopped ? undefined : current;
    })) return stopped;
    assert.equal(projectItem(readIssue())?.status?.name, statuses.humanReview, `${statuses.humanReview} status read-back differs`);
    return result('ok', 'HANDOFF', { headline: `HANDOFF #${number} PR #${state.value} head ${pr.headRefOid}`, details: gate.lines, data });
  }

  /** Mark a Draft PR ready only for the explicitly expected pushed commit; stale metadata is waited out, never trusted. */
  function ready(prNumber = number, sha = state.value) {
    const attempts = numberOption('--attempts', 6), interval = numberOption('--interval', 5);
    // Reads go over REST (no GraphQL points); the head wait and the read-back after the write still guard against a lagging answer.
    const read = () => {
      const pull = rest(`repos/${project.repository}/pulls/${prNumber}`);
      assert.ok(pull?.node_id && pull.number === prNumber, 'The PR is unreadable');
      assert.equal(typeof pull.draft, 'boolean', 'PR draft state is unreadable');
      return { id: pull.node_id, state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED', isDraft: pull.draft, headRefOid: pull.head.sha,
        isCrossRepository: pull.head.repo?.id !== pull.base.repo.id, headRepository: { nameWithOwner: pull.head.repo?.full_name } };
    };
    const refuse = failed;
    let pr;
    for (let attempt = 1; ; attempt++) {
      pr = read();
      if (pr.state !== 'OPEN') return refuse(`PR #${prNumber} is ${pr.state.toLowerCase()}`);
      // A fork's or another repository's branch is not ours to mark ready.
      // GitHub reports the canonical spelling; the configured OWNER/REPO may differ in case.
      if (pr.isCrossRepository || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) return refuse(`PR #${prNumber} does not come from a branch of ${project.repository}`);
      if (!pr.isDraft) {
        if (!pr.headRefOid.startsWith(sha.toLowerCase())) return refuse(`PR #${prNumber} is already ready with head ${pr.headRefOid.slice(0, 7)}, not ${sha.slice(0, 7)}`);
        return result('ok', 'READY', { headline: `READY #${prNumber} head ${pr.headRefOid} (already ready)`, data: { pr: prNumber, head: pr.headRefOid } });
      }
      if (pr.headRefOid.startsWith(sha.toLowerCase())) break;
      if (attempt >= attempts) return refuse(`PR #${prNumber} still reports head ${pr.headRefOid.slice(0, 7)} after ${attempts} reads; expected ${sha.slice(0, 7)}`);
      sleep(interval);
    }
    // One more read narrows the window in which a new push could slip between check and mutation.
    const current = read();
    if (current.state !== 'OPEN' || !current.isDraft || current.headRefOid !== pr.headRefOid) return refuse('the PR changed after the check; read it again');
    graphql('mutation($pr:ID!){markPullRequestReadyForReview(input:{pullRequestId:$pr}){pullRequest{number}}}', { pr: pr.id });
    // A write only counts once the read-back shows the expected head ready.
    for (let attempt = 1; ; attempt++) {
      const done = read();
      if (done.state === 'OPEN' && !done.isDraft && done.headRefOid === pr.headRefOid) break;
      assert.ok(attempt < attempts, `Ready read-back differs: draft ${done.isDraft}, head ${done.headRefOid.slice(0, 7)}`);
      sleep(interval);
    }
    return result('ok', 'READY', { headline: `READY #${prNumber} head ${pr.headRefOid}`, data: { pr: prNumber, head: pr.headRefOid } });
  }

  return { findHandoffComment, selfReviewChecks, selfReviewReasons, finishedPr, handoff, ready };
}
