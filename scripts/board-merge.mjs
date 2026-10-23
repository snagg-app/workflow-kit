// `merge PR [--stack]`: the merge gate, the head-bound merge, the branch update and what follows a merge (branch delete, push commands).
// A factory over `env`, so tests and other commands can import it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProfileAt } from './project-profile.mjs';
import { SonarOtherPr } from './sonar.mjs';
import { shared } from './board-args.mjs';
import { failed, isResult, result } from './board-result.mjs';

const kitRoot = fileURLToPath(new URL('..', import.meta.url)); // the kit checkout that runs board.mjs

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'merge', run: 'merge', writes: true, doc: 'docs/board/merge.md', words: [{ name: 'PR', kind: 'number' }],
    summary: 'Merges a PR (the only way for an agent with merge authority). It applies the gates of `done`, waits for CI and reviewers, merges the checked head and reads the merge back.',
    flags: { '--stack': { help: 'PR is the top of a native stack: merge every layer in one run.' }, '--stall': shared.stall, '--grace': shared.grace,
      '--interval': { value: 'SECONDS', kind: 'seconds60', help: 'A fixed pause between looks, 0 to 60.' }, '--max-minutes': shared.maxMinutes } },
];

/** env: project, owner, name, github, projectDirectory, number, stack, stackState, numberOption, sleep, readyQuery, dependentPrs, mergeGate, stackReasons, runShell, gitAt, reviewsForHead, poll, progress, readPr, baseMovement, filesText */
export function createMerge(env) {
  const { project, owner, name, github, projectDirectory, number, stack, stackState, numberOption, sleep, readyQuery, dependentPrs,
    mergeGate, stackReasons, runShell, gitAt, reviewsForHead, poll, progress, readPr, baseMovement, filesText } = env;
  const { graphql, rest } = github;

  /**
   * Merge the moved base into the PR branch (update-branch, only if the head is still `head`), then wait until the PR shows the new head.
   * GitHub answers 403 for a PR with stacked children (#321): that ends the run with the manual way (nobody pushes for the caller) and returns that FAILED result.
   */
  function updateBranch(head, base) {
    try {
      github.write('PUT', `repos/${project.repository}/pulls/${number}/update-branch`, { fields: { expected_head_sha: head } });
    } catch (error) {
      if (!/\b403\b|stacked PR's branch/.test(`${error.stderr}${error.stdout}`)) throw error;
      return failed(`GitHub refuses the branch update with 403 (typical for a PR with stacked children): run \`git merge origin/${base}\` in the PR's worktree, push once, then run \`board.mjs merge ${number}\` again`);
    }
    // update-branch answers 202 before the new head exists, and the PR reports the previous head for a moment.
    for (let read = 1; ; read++) {
      const fresh = graphql(readyQuery, { owner, name, number }).repository.pullRequest.headRefOid;
      if (fresh !== head) return fresh;
      assert.ok(read < 10, `PR #${number} still shows head ${head.slice(0, 7)} after the branch update; run merge again`);
      sleep(numberOption('--interval', 3));
    }
  }

  /**
   * Delete the merged head branch, unless the repository does it itself (`delete_branch_on_merge`) or it is not ours to delete: another repository's, the default branch (a sync PR from
   * `main` has it as head), or the base of an open PR (a stack: GitHub would close that PR). Returns the line to report.
   * ponytail: check and delete are two calls, a PR opened on the branch in between is closed by the delete; replace when GitHub offers a conditional delete.
   */
  function deleteHeadBranch(pr) {
    const branch = pr.headRefName;
    if (pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) return `branch kept: ${branch} is not a branch of ${project.repository}`;
    const repository = rest(`repos/${project.repository}`);
    // With "Automatically delete head branches" GitHub deletes it itself, and a manual delete would answer 422.
    if (repository.delete_branch_on_merge) return `branch kept: ${project.repository} deletes merged head branches itself`;
    if (branch === repository.default_branch) return `branch kept: ${branch} is the default branch`;
    const dependents = dependentPrs(branch);
    if (dependents.length) return `branch kept: ${branch} is the base of open PR ${dependents.map(({ number: dependent }) => `#${dependent}`).join(', ')}`;
    try {
      github.write('DELETE', `repos/${project.repository}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    } catch (error) {
      // A branch that is already gone (the repository deletes merged branches itself) is no failure.
      if (!/\b(404|422)\b|Reference does not exist|Not Found/.test(`${error.stderr}${error.stdout}`)) throw error;
      return `branch gone: ${branch}`;
    }
    return `branch deleted: ${branch}`;
  }


  /**
   * After a merge into main or a release branch the `push` commands of `.github/workflow-project.json` as on the merge commit run here, in the
   * foreground (sweep, release sync, pin). They run with BRANCH in a throwaway worktree on that commit, without setup (the kit is a link
   * to the kit checkout that runs this, as the session hook does), and a project without such commands touches no git at all. A merge is never undone by a failure here;
   * it returns the note that says so.
   * ponytail: the commands run in bash, on Windows the one of Git for Windows (not WSL's), elsewhere /bin/bash; the 30 minutes kill bash, not the children it started;
   * replace when a project needs another shell or tree-kill.
   */
  function runPush(branch, merged) {
    if (!merged || (branch !== 'main' && !branch.startsWith('release/'))) return;
    let work;
    const run = gitAt;
    try {
      const commands = readProfileAt(rest, project.repository, merged).push;
      if (!commands.length) return;
      run(projectDirectory, 'fetch', '--quiet', 'origin', branch);
      work = mkdtempSync(join(tmpdir(), 'board-push-'));
      run(projectDirectory, 'worktree', 'add', '--quiet', '--detach', work, merged);
      // the scripts need the kit: the link the session hook makes (kit-hook.mjs checkKit)
      mkdirSync(join(work, '.vendor'), { recursive: true });
      symlinkSync(kitRoot, join(work, '.vendor/workflow-kit'), 'junction');
      for (const command of commands) runShell(run(projectDirectory, '--exec-path'), work, command, { BRANCH: branch });
    } catch (error) {
      return `note: the push commands of ${branch} failed (${String(error.message).split('\n')[0]})`;
    } finally {
      if (work) try { rmSync(join(work, '.vendor/workflow-kit'), { force: true }); rmSync(work, { recursive: true, force: true }); run(projectDirectory, 'worktree', 'prune'); } catch { /* only tidiness */ }
    }
  }

  /**
   * Merge for agents with merge authority: the same gate as handoff (CI, every traced review finished, no blocker or open
   * thread). A single PR is merged as it is, whatever the base gained since (#552); only a red check can ask for the base first (below).
   * Then exactly the checked head: `--match-head-commit` needs the full object id, and it also refuses a push that lands after the check, so
   * no recheck window is left to close. Repeated once only for "Base branch was modified" (#638: gate again, then merge again); any other refusal by gh ends as ERROR, except the stack refusal of a PR with stacked children (#321),
   * which goes once to merge-async with the same head and is read back until merged. A Sonar check that links the analysis of another PR (sync PRs with one head, #640) gets the base merged once, like a red check. Afterwards the head branch goes (see deleteHeadBranch).
   * `--stack`: PR is the top of a native stack. Every layer holds its own gate first (stackReasons), CI and reviewers count for the top head
   * only (it contains all layers), then the top alone goes to merge-async: GitHub merges every layer below it too, bottom first, and shows each as merged (#389).
   * A moved trunk under files the stack changes is the driver's to merge into the top layer (update-branch would only merge the layer below).
   */
  async function merge() {
    let viewer;
    if (stack) {
      ({ viewer } = graphql('query{viewer{login}}'));
      assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
      // Fail before the CI wait when a layer lacks something.
      const reasons = stackReasons(viewer);
      if (reasons.length) return failed(reasons);
    }
    const look = () => reviewsForHead(); // an unchanged REST marker answers from the last full read, like `wait`
    // Like `wait`: look again until CI and the reviewers have finished (or --max-minutes runs out: exit 4); the gate then decides once.
    let polled, stopped, didUpdate = false;
    // The new head's CI (and any reviewer that answers the push) decides, so the gate runs again; one update per run. False: `stopped` is the result that ends the run.
    const update = async ({ baseRefName, headRefOid: before }, why) => {
      assert.match(before, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
      progress(`update: ${why}; merging ${baseRefName} into the PR branch first`);
      const updated = updateBranch(before, baseRefName);
      if (isResult(updated)) return !(stopped = updated);
      didUpdate = true;
      progress(`updated: head ${before.slice(0, 7)} -> ${updated.slice(0, 7)}; waiting for CI`);
      polled = await poll(look);
      return !isResult(polled) || !(stopped = polled);
    };
    try {
      polled = await poll(look);
    } catch (error) {
      // Two sync PRs with one head share the Sonar analysis, which links the other PR (#640): a new head gets its own analysis.
      if (stack || !(error instanceof SonarOtherPr)) throw error;
      if (!await update(readPr(number), 'the SonarCloud check links the analysis of another PR')) return stopped;
    }
    if (isResult(polled)) return polled;
    // A red check from "updateBranchChecks" as the only reason asks for the base (#383): that is the update, not a FAILED.
    // Any other red check on a head the base has left behind may come from the old merge state (#425): the base is merged once and the new CI decides; a second red is FAILED.
    const stale = !stack && !didUpdate && polled.failed && !polled.baseOnly && polled.reasons.every(reason => reason.startsWith('check ')) ? baseMovement(polled.pr) : null;
    const forCheck = !stack && !didUpdate && (polled.baseOnly || stale);
    if (forCheck && !await update(polled.pr, stale ? `${polled.pr.baseRefName} gained ${stale.behind} commits since the merge-base; ${polled.reasons.join('; ')}` : polled.reasons.join('; '))) return stopped;
    // The successful poll just checked this head; an update above replaces that proof before the atomic head-bound merge.
    const gate = mergeGate(viewer, polled);
    if (isResult(gate)) return gate;
    assert.match(gate.pr.headRefOid, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
    const moved = stack ? baseMovement({ ...gate.pr, baseRefName: stackState.trunk }) : null;
    if (moved?.shared.length) {
      return failed(`${stackState.trunk} gained ${moved.behind} commits that change ${filesText(moved.shared)} like this stack: run \`git merge origin/${stackState.trunk}\` in the top layer's worktree, push once, then run \`board.mjs merge ${number} --stack\` again`);
    }
    let { headRefOid } = gate.pr;
    let asynchronous = false;
    const mergeAsync = () => {
      // Without the version header GitHub answers 404 for a stacked PR (#492); direct_merge is still a valid merge_action with it. The result is read from the PR below.
      github.write('PUT', `repos/${project.repository}/pulls/${number}/merge-async`,
        { header: 'X-GitHub-Api-Version: 2026-03-10', fields: { merge_action: 'direct_merge', merge_method: 'merge', sha: headRefOid } });
      asynchronous = true;
    };
    // A stack is merged by GitHub from its top, and a plain `gh pr merge` of the top would land it in the layer below: merge-async only.
    const ghMerge = () => github.run(['pr', 'merge', String(number), '--repo', project.repository, '--merge', '--match-head-commit', headRefOid],
      { stdio: 'pipe' });
    if (gate.merged) progress(`note: PR #${number} is already merged`); else if (stack) mergeAsync(); else try {
      try {
        ghMerge();
      } catch (error) {
        // Another PR landed on the base a moment ago (#638): read the PR and run the gate again, then merge once more. A second refusal ends as before.
        if (!/Base branch was modified/i.test(`${error.stderr}${error.stdout}`)) throw error;
        progress('note: the base branch was modified during the merge; checking the PR again and merging once more');
        polled = await poll(look);
        if (isResult(polled)) return polled;
        const again = mergeGate(viewer, polled);
        if (isResult(again)) return again;
        assert.match(again.pr.headRefOid, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
        ({ headRefOid } = again.pr);
        if (again.merged) progress(`note: PR #${number} is already merged`); else ghMerge();
      }
    } catch (error) {
      // A PR with stacked children (#321) is refused, but accepted by merge-async: same merge, same head, the answer is 202 and the merge follows in the background.
      // GitHub's GraphQL text is "part of a stack and must be merged using the asynchronous merge REST API"; a REST merge answers HTTP 403.
      // ponytail: a bare HTTP 403 (e.g. a token without permission) also tries merge-async once, which then ends as ERROR; add a stack qualifier when a real 403 text is captured.
      const text = `${error.stderr}${error.stdout}`;
      if (!/part of a stack|asynchronous merge REST API|HTTP 403/i.test(text)) throw error;
      progress(`note: gh pr merge was refused (${/HTTP 403/i.test(text) ? 'HTTP 403' : 'part of a stack'}); merging the same head with merge-async`);
      mergeAsync();
    }
    // What happened after the merge, one line each; the merge is done and read back: nothing about the branch may turn it into an ERROR.
    const notes = [];
    const dropBranch = pr => {
      try { notes.push(deleteHeadBranch(pr)); } catch (error) {
        notes.push(`note: branch ${pr.headRefName} not deleted (${String(error.stderr || error.message).trim()})`);
      }
    };
    // merge-async answers 202 and merges in the background: read until the PR shows it (a stack layer too).
    const readMerged = (layer, until) => {
      for (let read = 1; ; read++) {
        const current = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
          pullRequest(number:$number){state mergeCommit{oid}}}}`, { owner, name, number: layer }).repository.pullRequest;
        if (!until || current.state === 'MERGED' || read >= 10) return current;
        sleep(numberOption('--interval', 3));
      }
    };
    const { state, mergeCommit } = readMerged(number, asynchronous);
    assert.equal(state, 'MERGED', `Merge read-back shows #${number} as ${state}${asynchronous ? '; merge-async was accepted and may still land: read the PR before merging again' : ''}`);
    // The line an agent reads first comes before the slow steps below (layers, issues, push commands), which may run for minutes or fail.
    const headline = `MERGED #${number} head ${headRefOid} merge commit ${mergeCommit?.oid}`;
    progress(headline);
    let unmerged = false;
    // The layers below: GitHub marks each as merged with the top; one line per layer, its issues and head branch (the top's goes below).
    for (const layer of stack ? stackState.order : []) {
      const { pr, issues } = stackState.layers.get(layer);
      if (layer !== number) {
        const lower = readMerged(layer, true);
        notes.push(`${lower.state === 'MERGED' ? 'MERGED' : `NOT MERGED (${lower.state})`} #${layer} head ${pr.headRefOid} merge commit ${lower.mergeCommit?.oid}`);
        if (lower.state !== 'MERGED') unmerged = true;
        else dropBranch(pr);
      }
      // Whatever the trunk is: GitHub or the project's workflow closes the issues of a PR merged into the trunk, but not those of the upper layers (their base was a layer branch, #418).
      // A layer's issue that is still open after a short re-read (#397) is closed here, with a pointer to the merged PR.
      for (const issueNumber of issues) {
        try {
          const path = `repos/${project.repository}/issues/${issueNumber}`;
          let open;
          for (let read = 1; (open = rest(path).state !== 'closed') && read < 5; read++) sleep(numberOption('--interval', 3));
          if (open) {
            github.write('POST', `${path}/comments`,
              { body: `Geschlossen von \`board.mjs merge --stack\`: PR #${layer} ist in ${stackState.trunk} gemergt, GitHub hat das Issue nicht selbst geschlossen.\n` });
            github.write('PATCH', path, { fields: { state: 'closed', state_reason: 'completed' } });
          }
          notes.push(`issue #${issueNumber} (PR #${layer}): closed`);
        } catch (error) { notes.push(`note: issue #${issueNumber} (PR #${layer}) not handled (${String(error.stderr || error.message).trim()})`); }
      }
    }
    dropBranch(gate.pr);
    const pushed = runPush(stack ? stackState.trunk : gate.pr.baseRefName, mergeCommit?.oid);
    if (pushed) notes.push(pushed);
    // A layer below that is not merged with the top is an error, whatever the top did.
    return result(unmerged ? 'error' : 'ok', 'MERGED', { headline: null, notes,
      data: { pr: number, head: headRefOid, mergeCommit: mergeCommit?.oid } });
  }

  return { merge };
}
