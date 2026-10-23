// `done ISSUE`: tests, ready, review and handoff.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';
import { runProgram } from './board-process.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shared } from './board-args.mjs';
import { failed, isResult, result } from './board-result.mjs';
import { pushPlan } from './board-checkout.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'done', run: 'done', writes: true, doc: 'docs/board/done.md', words: [{ name: 'ISSUE', kind: 'number' }, { name: 'PR', optional: true }, { name: 'HANDOFF_FILE', optional: true }],
    summary: 'Everything from the last push to Human review. Steps: tests, PR ready, acceptance boxes, Automated review, wait for CI and reviewers, handoff comment, gate. A repeated call does what is still open; without HANDOFF_FILE it only prepares.',
    flags: { '--refs': shared.refs, '--no-pr': { help: 'An exploration without a PR may reach Human review.' }, '--max-minutes': shared.maxMinutes,
      '--skip-local-tests': { value: 'REASON', help: 'Skip only the local test run and name why (CI and review gates still apply).' }, '--issue-repo': shared.issueRepo } },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createDone(env) {
  const { args, checkout, git, github, graphql, isSpec, issueName, issueOwner, issueProject, lines, localHead, number, progress, project, projectDirectory, projectStatus, readIssue, rest, restAll, restPost, specRefusal, state, statuses, step, texts } = env;
  const { baseSettings, currentIssuePr, findHandoffComment, handoff, isPartialPr, openFirstPr, poll, postBacklink, ready, resolveOption, reviewOutcome, reviewsForHead, set, tickAcceptance, useBaseSettings, writeBody } = env.later;

  /**
   * `done ISSUE [PR] [HANDOFF_FILE]`: everything from the last push to Human review. First the target branch's doneBaseMerge policy decides whether the fetched PR base is merged and pushed (a conflict fails, the merge aborted). The targeted tests of the changed files (in the
   * foreground, once per head), the PR ready for exactly the pushed head, the acceptance boxes ticked, Automated review, the wait for CI and reviewers (`still waiting: call done again`, exit 4, after --max-minutes), the handoff comment from HANDOFF_FILE
   * (result sentence and the `### Retro` list; heading and head line are added here) and the handoff gate with its Sonar issue count. Every call
   * does what is still open, so a repeated call after a push or a wait is the same call. PR: the one open PR that closes the issue.
   * `--skip-local-tests REASON` skips only local tests without updating the tested-head marker; CI and review gates still apply.
   * Without HANDOFF_FILE (and without a comment for the head) it stops after the automated review with `PREPARED` (exit 0): the final proof runs, then `done ISSUE FILE`.
   * `--refs`: a PR that only names the issue (a part for another base): its gate runs, the issue status stays.
   */
  async function done() {
    const skipReason = args.value('--skip-local-tests')?.trim();
    assert.ok(!args.flag('--skip-local-tests') || skipReason, '--skip-local-tests needs a non-empty reason');
    const words = args.words.slice(1);
    const given = /^\d+$/.test(words[0] ?? '') ? Number(words.shift()) : undefined, file = words.shift();
    assert.ok(!words.length, 'done takes ISSUE [PR] [FILE]');
    const issue = readIssue(), found = currentIssuePr(issue);
    let prNumber = given ?? found.number;
    if (prNumber === undefined && !found.unknown && !args.flag('--refs')) prNumber = openFirstPr(issue);
    // #646: nothing `done` pushes may reach main or release/** (private repos have no branch protection). The first push has just moved the work onto its own branch; the later push names that branch, so an upstream on the base is harmless (#651).
    const early = prNumber === undefined ? {} : pushPlan({ stand: checkout.stand(), number });
    if (early.refuse) return failed(early.refuse);
    // No open PR but a FILE: a check task whose PR is already closed (or never opened) takes the way of the PR without a change.
    if (prNumber === undefined) assert.ok(file && !found.unknown, found.unknown ?? `no open PR closes #${number}: run board.mjs start ${number}, name the PR (done ${number} PR), or name the FILE with the result for the issue`);
    const pull = prNumber === undefined ? undefined : rest(`repos/${project.repository}/pulls/${prNumber}`);
    const partial = prNumber !== undefined && (args.flag('--refs') || isPartialPr(issue, prNumber));
    assert.ok(partial || !isSpec(issue), specRefusal(number, 'done is refused; agents leave specs untouched (use --refs for a partial PR)'));
    // A PR without a change (a check task: `start` opened it as the claim) delivers nothing to merge: the result goes to the issue, the PR closes.
    if ((!pull || pull.changed_files === 0) && !partial) {
      assert.ok(file, `PR #${prNumber} has no change: name the FILE with the result for the issue`);
      if (pull) try {
        const head = localHead(), base = pull.base.sha;
        assert.equal(pull.head.sha, head, 'PR head differs from the expected pushed checkout head');
        assert.equal(git('branch', '--show-current'), pull.head.ref, 'checkout is not on the PR branch');
        assert.equal(pull.head.repo?.full_name?.toLowerCase(), project.repository.toLowerCase(), 'PR branch belongs to another repository');
        assert.match(base ?? '', /^[a-f0-9]{40}$/, 'PR base commit is missing');
        git('fetch', 'origin', base, head);
        const mergeBase = git('merge-base', base, head);
        git('diff', '--quiet', mergeBase, head);
        const again = rest(`repos/${project.repository}/pulls/${prNumber}`);
        assert.equal(again.head.sha, head, 'PR head changed during the comparison');
        assert.equal(again.base.sha, base, 'PR base changed during the comparison');
        assert.equal(again.base.ref, pull.base.ref, 'PR base branch changed during the comparison');
        assert.equal(again.changed_files, 0, 'PR file count contradicts the comparison');
        assert.equal(again.state, 'open', 'PR is no longer open');
        assert.equal(git('ls-remote', '--exit-code', 'origin', `refs/heads/${pull.head.ref}`), `${head}\trefs/heads/${pull.head.ref}`, 'live remote branch differs from the expected pushed head');
      } catch (error) { return failed(`cannot confirm no-change evidence for PR #${prNumber}: ${String(error.stderr || error.message).trim()}; run done again`); }
      // Prepare and FILE can straddle a human merge: refresh closure immediately before the first issue mutation.
      try {
        const fresh = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
        state stateReason closedByPullRequestsReferences(first:100,includeClosedPrs:true){totalCount nodes{number state mergeCommit{oid} repository{nameWithOwner}}}}}}`,
        { owner: issueOwner, name: issueName, number }).repository.issue;
        assert.ok(fresh && ['OPEN', 'CLOSED'].includes(fresh.state), 'issue closure state is unreadable');
        const linked = currentIssuePr(fresh);
        assert.ok(!linked.unknown, linked.unknown);
        if (fresh.state === 'CLOSED') {
          assert.equal(fresh.stateReason, 'COMPLETED', 'closed issue is not confirmed completed');
          const merged = fresh.closedByPullRequestsReferences.nodes.find(pr => pr.state === 'MERGED'
            && pr.repository?.nameWithOwner?.toLowerCase() === project.repository.toLowerCase());
          assert.ok(Number.isSafeInteger(merged?.number) && merged.number > 0 && /^[a-f0-9]{40}$/.test(merged.mergeCommit?.oid ?? ''), 'closed issue has no readable linked merged PR');
          return result('ok', 'ALREADY DONE', { headline: `ALREADY DONE #${number}: closed as completed; PR #${merged.number} merged (${merged.mergeCommit.oid}); no changes`, data: { issue: number, pr: merged.number } });
        }
        assert.equal(linked.number, prNumber, 'the open issue-linked PR changed; run done again');
      } catch (error) { return failed(`cannot confirm issue closure for #${number}: ${String(error.stderr || error.message).trim()}; no changes`); }
      // #646: no PR delivers nothing for review; only an exploration that says so (--no-pr) gets Human review, otherwise nothing changes.
      if (!pull && !args.flag('--no-pr')) return failed(`no PR for #${number}, so the status stays. Commit your work and run done again (it opens the Draft PR), or for an exploration without a code change: done ${number} FILE --no-pr`);
      restPost(`repos/${issueProject.repository}/issues/${number}/comments`, ['-F', 'body=@-'], `## ${texts.handoff}\n\n${lines(file)}\n`);
      if (pull) github.run(['api', `repos/${project.repository}/pulls/${prNumber}`, '-X', 'PATCH', '-f', 'state=closed'], { stdio: 'pipe' });
      const written = writeBody(before => tickAcceptance(before));
      if (written.exitCode) return written;
      step(written);
      set('Status', statuses.humanReview);
      return pull ? result('ok', 'CLOSED', { headline: `CLOSED PR #${prNumber} (no change); the result is in the comment on #${number}`, data: { issue: number, pr: prNumber } })
        : result('ok', 'DONE', { headline: `DONE #${number} (no PR); the result is in the comment on #${number}`, data: { issue: number } });
    }
    // Validate the review destination before a base merge/push or ready mutation; backlinks still run after ready.
    if (!partial) resolveOption('Status', statuses.automatedReview);
    // The tests of a head run once: a call that only waits (after exit 4) neither repeats them nor merges a base that moved meanwhile.
    const tested = resolve(projectDirectory, git('rev-parse', '--git-path', 'board-done-tested'));
    const isTested = () => existsSync(tested) && readFileSync(tested, 'utf8') === localHead();
    let gate;
    try {
      useBaseSettings({ baseRefName: pull.base.ref });
      gate = baseSettings();
      assert.ok(gate.doneBaseMerge === undefined || ['always', 'overlap'].includes(gate.doneBaseMerge),'doneBaseMerge must be always or overlap; omit it for always');
    } catch (error) { return failed(`cannot read the base-merge policy: ${error.message}`); }
    // An untested head applies the target base's policy (#558, #579). A conflict is aborted, the branch stays as it was.
    // #656: a head the PR does not show yet is pushed even when its tested marker exists (a run that ended after the tests).
    if (!isTested() || localHead() !== pull.head.sha) {
      const base = `origin/${pull.base.ref}`, failure = error => String(error.stderr || error.message).trim();
      // Only the PR's own branch of this repository is merged into and pushed.
      const pr = { branch: pull.head.ref, head: pull.head.sha, number: prNumber, repository: project.repository, sameRepo: pull.head.repo?.full_name?.toLowerCase() === project.repository.toLowerCase() };
      const wrongBranch = pushPlan({ stand: checkout.stand(), number, pr }).refuse;
      if (wrongBranch) return failed(wrongBranch);
      try { git('fetch', 'origin'); } catch (error) { return failed(`cannot fetch the base ${base}: ${failure(error)}`); }
      let mergeNeeded = true, mergeTarget = base;
      if (gate.doneBaseMerge === 'overlap') try {
        const head = localHead();
        mergeTarget = git('rev-parse', base);
        const ancestor = git('merge-base', head, mergeTarget);
        const paths = target => git('diff', '--name-only', '-z', '--no-renames', ancestor, target).split('\0').filter(Boolean);
        const own = new Set(paths(head));
        mergeNeeded = paths(mergeTarget).some(path => own.has(path));
        // A directory/file conflict can affect distinct paths; Git probes it without touching the checkout.
        if (!mergeNeeded) try { git('merge-tree', '--write-tree', head, mergeTarget); } catch (error) {
          if (error.status !== 1) throw error;
          mergeNeeded = true;
        }
      } catch (error) { return failed(`cannot compare the base ${base}: ${failure(error)}`); }
      // A branch that has the base stays as it is ("Already up to date", no commit).
      if (mergeNeeded) {
        try { git('merge', '--no-edit', mergeTarget); } catch (error) {
          const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
          try { git('merge', '--abort'); } catch { /* no merge was started */ }
          return failed(`merging ${base} conflicts${files.length ? ` in ${files.join(', ')}` : `: ${failure(error)}`}; merge it yourself, push, then run done again`);
        }
      }
      // #659: new local commits (a correction after an earlier done) are pushed even when no base merge was needed.
      const plan = pushPlan({ stand: checkout.stand(), number, pr, mergeNeeded });
      if (plan.push) {
        try { git(...plan.args); } catch (error) { return failed(`cannot push HEAD${mergeNeeded ? ` after merging ${base}` : ''}: ${failure(error)}`); }
      }
    }
    const sha = localHead();
    // Without a file and without a comment for this head (a repeated call after exit 4 has one) `done` only prepares (#576): it runs to the end of the automated review, then stops before comment, ticking and Human review.
    const prepare = !file && !findHandoffComment(restAll(`repos/${project.repository}/issues/${prNumber}/comments`), issue.viewer, sha);
    if (skipReason) progress(`LOCAL TESTS SKIPPED ${sha}: ${skipReason}`);
    else if (!isTested()) {
      // The green steps of this head are kept (--resume): after a red step the next call runs only the open ones.
      const steps = resolve(projectDirectory, git('rev-parse', '--git-path', 'board-done-steps'));
      try {
        runProgram(process.execPath, [fileURLToPath(new URL('affected-tests.mjs', import.meta.url)), '--cwd', projectDirectory, '--run', '--resume', steps, '--base', `origin/${pull.base.ref}`], { stdio: 'inherit' });
      } catch { return failed('the targeted tests of the changed files failed (output above; green steps of this head are kept); fix the cause, then run done again (a push starts all steps anew)'); }
      writeFileSync(tested, sha);
    }
    const took = (name, since) => progress(`done: ${name} took ${((Date.now() - since) / 1000).toFixed(1)} s`);
    const readyStart = Date.now();
    const readied = ready(prNumber, sha);
    took('ready', readyStart);
    if (readied.exitCode) return readied;
    step(readied);
    state.value = String(prNumber);
    state.delivered = [state.value];
    const status = projectStatus(issue);
    if (partial) progress(postBacklink(number, pull.html_url));
    // A head prepared after an earlier handoff has no handoff yet: it leaves Human review.
    else if (status !== statuses.automatedReview && (prepare || status !== statuses.humanReview)) set('Status', statuses.automatedReview);
    progress('done: waiting for CI and reviews');
    const waitStart = Date.now(), polled = await poll(() => reviewsForHead(prNumber));
    took('CI and reviews', waitStart);
    if (isResult(polled)) return polled;
    if (polled.failed) return reviewOutcome(polled, { quota: true });
    const head = polled.pr.headRefOid;
    if (prepare) return result('ok', 'PREPARED', { headline: `PREPARED #${number} head ${head.slice(0, 7)}: ${skipReason ? 'local tests skipped; ready' : 'tests, ready'} and automated review are done; no handoff comment, boxes stay open, no Human review. ${skipReason ? 'Repeat --skip-local-tests REASON to skip local tests again; then run' : 'Run the final proof, then'} board.mjs done ${number} FILE`,
      data: { issue: number, pr: prNumber, head } });
    // Boxes are ticked only once the checks of the head are green.
    if (!partial) {
      const written = writeBody(before => tickAcceptance(before));
      if (written.exitCode) return written;
      step(written);
    }
    if (file && !findHandoffComment(polled.comments, issue.viewer, head)) {
      restPost(`repos/${project.repository}/issues/${prNumber}/comments`, ['-F', 'body=@-'], `## ${texts.handoff}\n\nHead: ${head.slice(0, 7)}\n\n${lines(file)}\n`);
    }
    return handoff();
  }

  return { done };
}
