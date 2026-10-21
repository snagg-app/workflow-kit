// Stacked PRs: the base of a stack, its layers and `stack-sync`.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externalTool } from './checkout-root.mjs';

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createStack(env) {
  const { graphql, isSpec, loadDeliveries, name, number, owner, project, projectDirectory, projectItem, readIssue, rest, restAll, stackOrderText, statuses, texts } = env;
  const { filesText, findHandoffComment, finishedPr, readPr, selfReviewChecks, selfReviewReasons, unresolvedThreads } = env.later;

  function readStackPr(prNumber) {
    const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){number state isDraft isCrossRepository headRepository{nameWithOwner} baseRefName headRefName headRefOid}}}`,
    { owner, name, number: prNumber }).repository;
    assert.ok(pr?.number === prNumber && ['OPEN', 'MERGED'].includes(pr.state), `PR #${prNumber} is unreadable`);
    if (pr.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) {
      return { refused: `PR #${prNumber} comes from a fork or another repository` };
    }
    if (pr.state === 'OPEN' && pr.isDraft !== false) return { refused: `PR #${prNumber} is still Draft` };
    if (typeof pr.baseRefName !== 'string' || typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string') {
      assert.fail(`PR #${prNumber} has incomplete branch data`);
    }
    return { pr: { ...pr, repository: { nameWithOwner: project.repository } } };
  }

  function stackMembers(stack) {
    assert.ok(Number.isSafeInteger(stack.number) && stack.number > 0 && Array.isArray(stack.pull_requests), 'The native stack is incomplete');
    const members = stack.pull_requests;
    assert.ok(members.length >= 2 && members.every(member => Number.isSafeInteger(member.number) && member.number > 0)
      && new Set(members.map(member => member.number)).size === members.length, 'The native stack members are incomplete or repeated');
    return members;
  }

  /**
   * Resolve the native base for a dependent issue (docs/CONTRIBUTING.md#stacked-pull-requests). Every open predecessor must
   * be delivered by a local, ready PR. If several blocker PRs exist, a single open native stack must contain them all.
   * New work uses its tip; resuming an issue whose own PR is already in that stack uses the immediately lower member.
   * Incomplete data is `unknown`, never a fallback to the bottom PR. A sole merged delivery stays a plain PR on its trunk.
   */
  function stackBase(open, currentPrNumber) {
    loadDeliveries(open);
    const refused = [], unknown = [], prs = new Map();
    for (const predecessor of open) {
      const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
      const links = predecessor.closedByPullRequestsReferences;
      if (predecessor.repository.nameWithOwner.toLowerCase() !== project.repository.toLowerCase()) refused.push(`${label} is in another repository`);
      else if (!links?.nodes || links.nodes.filter(Boolean).length < links.totalCount) unknown.push(`the pull requests of ${label} are not completely readable`);
      else {
        const delivering = links.nodes.filter(pr => ['OPEN', 'MERGED'].includes(pr.state));
        if (!delivering.length) refused.push(`${label} has no open or merged PR`);
        if (delivering.length > 1) refused.push(`${label} is delivered by ${delivering.length} open or merged PRs, not one`);
        // A closing keyword can also come from a PR of another repository, which is no local branch to stack on.
        for (const pr of delivering) {
          if (pr.repository?.nameWithOwner?.toLowerCase() === project.repository.toLowerCase()) prs.set(pr.number, pr);
          else refused.push(`PR #${pr.number} of ${label} belongs to ${pr.repository?.nameWithOwner ?? 'an unreadable repository'}`);
        }
      }
    }
    if (refused.length || unknown.length || !prs.size) return { refused, unknown };
    const deliveries = [...prs.values()];
    if (deliveries.some(pr => pr.state === 'MERGED')) {
      if (deliveries.length > 1) refused.push(`the predecessors are delivered by ${deliveries.length} PRs (#${[...prs.keys()].join(', #')}), not one open native stack`);
      return { pr: refused.length ? undefined : deliveries[0], refused, unknown };
    }
    for (const pr of deliveries) {
      if (pr.isDraft) refused.push(`PR #${pr.number} is still Draft`);
      if (pr.isCrossRepository) refused.push(`PR #${pr.number} comes from a fork`);
      if (typeof pr.headRefName !== 'string' || typeof pr.headRefOid !== 'string' || typeof pr.baseRefName !== 'string') {
        unknown.push(`PR #${pr.number} has incomplete branch data`);
      }
    }
    if (refused.length || unknown.length) return { refused, unknown };

    try {
      const filterNumber = currentPrNumber ?? deliveries[0].number;
      const stacks = rest(`repos/${project.repository}/stacks?pull_request=${filterNumber}`);
      assert.ok(Array.isArray(stacks), 'The native stack list is unreadable');
      if (!stacks.length) {
        // The empty start claim stays unlinked until its first source diff (#606); handoff still requires native membership.
        if (currentPrNumber) return stackBase(open);
        if (deliveries.length > 1) refused.push('the blocker PRs are not proven members of one native stack');
        else return { pr: deliveries[0], refused, unknown };
      } else {
        assert.equal(stacks.length, 1, `PR #${filterNumber} belongs to an ambiguous number of native stacks`);
        const stack = stacks[0], members = stackMembers(stack), positions = new Map(members.map((member, index) => [member.number, index]));
        if (stack.open !== true) refused.push(`native stack #${stack.number} is closed`);
        else {
          const memberNumber = currentPrNumber ?? deliveries[0].number;
          assert.ok(positions.has(memberNumber), `The native stack response does not contain PR #${memberNumber}`);
          const currentIndex = positions.get(memberNumber);
          if (currentPrNumber) {
            if (currentIndex === 0) refused.push(`PR #${currentPrNumber} has no lower layer in its native stack`);
            for (const pr of deliveries) {
              if (!positions.has(pr.number) || positions.get(pr.number) >= currentIndex) {
                refused.push(`blocker PR #${pr.number} is not below PR #${currentPrNumber} in the same native stack`);
              }
            }
          } else {
            for (const pr of deliveries) if (!positions.has(pr.number)) refused.push(`blocker PR #${pr.number} is not in native stack #${stack.number}`);
          }
          if (!refused.length) {
            const baseIndex = currentPrNumber ? currentIndex - 1 : members.length - 1;
            const member = members[baseIndex];
            const source = prs.get(member.number);
            const resolved = source ? { pr: source } : readStackPr(member.number);
            if (resolved.refused) refused.push(resolved.refused);
            if (!resolved.pr) unknown.push(`PR #${member.number} at the native stack base is unreadable`);
            else {
              const stopped = members.slice(0, baseIndex).find(pr => pr.state === 'closed' && typeof pr.merged_at !== 'string');
              const previous = members.slice(0, baseIndex).findLast(pr => pr.state !== 'closed' || typeof pr.merged_at !== 'string');
              const expectedBase = previous ? previous.head?.ref : stack.base?.ref;
              if (stopped) refused.push(`PR #${stopped.number} below it in native stack #${stack.number} closed without merge`);
              else if (typeof expectedBase !== 'string' || typeof member.head?.ref !== 'string' || typeof member.head?.sha !== 'string') {
                unknown.push(`PR #${member.number} has incomplete native stack branch data`);
              } else if (resolved.pr.baseRefName !== expectedBase || resolved.pr.headRefName !== member.head.ref || resolved.pr.headRefOid !== member.head.sha) {
                unknown.push(`PR #${member.number} branch data changed while reading native stack #${stack.number}`);
              } else if (resolved.pr.state !== 'OPEN' || resolved.pr.isDraft || resolved.pr.isCrossRepository) {
                refused.push(`PR #${member.number} at the native stack base is not an open, ready PR from this repository`);
              } else return { pr: { ...resolved.pr, stackNumber: stack.number }, refused, unknown };
            }
          }
        }
      }
    } catch (error) {
      unknown.push(`native stack data are unreadable: ${String(error.stderr || error.message).trim()}`);
    }
    return { refused, unknown };
  }

  /** The native stacks of PR `number`. No Stacks API (404) means no stack. */
  function readStacks(pull = number) {
    let stacks;
    try { stacks = rest(`repos/${project.repository}/stacks?pull_request=${pull}`); } catch (error) {
      if (!/\b404\b|Not Found/.test(String(error.stderr))) throw error;
      stacks = [];
    }
    assert.ok(Array.isArray(stacks), 'The stack membership is unreadable');
    return stacks;
  }

  // What `merge --stack` read last: the open layers bottom first, the stack's trunk, and per layer its PR and issue numbers (for the report after the merge).
  const stackState = { order: [], trunk: undefined, layers: new Map() };

  /** Why one layer of the stack does not hold the gate of `handoff` (CI and reviewers are the top head's business only): handoff comment for its head, threads, change requests, issue status. */
  function layerReasons(layer, viewer) {
    const pr = readPr(layer);
    if (pr.state !== 'OPEN' || pr.isDraft) return ['is not an open, non-draft PR'];
    const reasons = [];
    if (!findHandoffComment(restAll(`repos/${project.repository}/issues/${layer}/comments`), viewer, pr.headRefOid)) {
      reasons.push(`has no handoff comment for head ${pr.headRefOid.slice(0, 7)} (a "## ${texts.handoff}" heading and a "Head: ${pr.headRefOid.slice(0, 7)}" line)`);
    }
    const threads = unresolvedThreads(layer, pr.reviewThreads);
    if (threads.length) reasons.push(`has ${threads.length} unresolved review thread${threads.length === 1 ? '' : 's'}`);
    assert.equal(pr.latestOpinionatedReviews.nodes.length, pr.latestOpinionatedReviews.totalCount, 'Not every review decision is readable');
    for (const review of pr.latestOpinionatedReviews.nodes.filter(review => review.state === 'CHANGES_REQUESTED')) reasons.push(`has a change request by ${review.author?.login}`);
    // A conflict in any layer locks the whole stack (#412).
    if (pr.mergeStateStatus === 'DIRTY') reasons.push(`has merge conflicts, which lock the whole stack: ${stackOrderText}`);
    reasons.push(...selfReviewReasons(pr.bodyHTML, selfReviewChecks()));
    const { nodes, totalCount } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
    closingIssuesReferences(first:100){totalCount nodes{number}}}}}`, { owner, name, number: layer }).repository.pullRequest.closingIssuesReferences;
    assert.equal(nodes.length, totalCount, `Not every issue link of PR #${layer} is readable`);
    assert.ok(nodes.every(Boolean), `An issue link of PR #${layer} is unreadable`);
    for (const { number: issueNumber } of nodes) {
      const linked = readIssue(false, issueNumber), status = projectItem(linked)?.status?.name;
      if (isSpec(linked)) reasons.push(`delivers spec #${issueNumber}, which only a human closes (AGENT_RULES.md, Hard rules): unlink it and write "Refs #${issueNumber}"`);
      if (status !== statuses.humanReview) reasons.push(`delivers issue #${issueNumber}, whose status is ${status ?? 'unset'}, not ${statuses.humanReview}`);
    }
    stackState.layers.set(layer, { pr, issues: nodes.map(issue => issue.number) });
    return reasons;
  }

  /** The reasons `merge --stack` refuses: PR `number` is not the top of exactly one native stack, or a layer lacks something. Names the layer. */
  function stackReasons(viewer) {
    const stacks = readStacks();
    if (stacks.length !== 1) return [`PR #${number} is ${stacks.length ? 'in several native stacks' : 'not in a native stack'}: --stack merges one stack`];
    const members = stackMembers(stacks[0]);
    assert.equal(typeof stacks[0].base?.ref, 'string', 'The native stack names no base branch');
    const open = members.filter(member => member.state === 'open');
    const closed = members.filter(member => member.state !== 'open' && !member.merged_at);
    if (closed.length) return closed.map(member => `PR #${member.number} in the stack is closed without merge`);
    if (!open.some(member => member.number === number)) return [`PR #${number} is not an open layer of its stack`];
    if (open.at(-1).number !== number) return [`PR #${open.at(-1).number} is above PR #${number} in its stack: run merge ${open.at(-1).number} --stack for the top layer`];
    stackState.order = open.map(member => member.number);
    stackState.trunk = stacks[0].base.ref;
    const reasons = stackState.order.flatMap(layer => layerReasons(layer, viewer).map(reason => `PR #${layer} ${reason}`));
    // GitHub merges each layer by its own head: a layer pushed after the one above it was built would merge on its own. Same rule as handoff.
    stackState.order.slice(1).forEach((upper, index) => {
      const lower = stackState.order[index], heads = [lower, upper].map(layer => stackState.layers.get(layer)?.pr.headRefOid);
      if (!heads.every(Boolean)) return;
      const { status } = rest(`repos/${project.repository}/compare/${heads[0]}...${heads[1]}`);
      if (!['ahead', 'identical'].includes(status)) reasons.push(`PR #${upper} does not contain the current head ${heads[0].slice(0, 7)} of PR #${lower} (compare says ${status}): rebase it onto it and push with the lease`);
    });
    return reasons;
  }

  /** The merge gate: handoff's PR gate plus the stack rule. Merging an upper layer of a stack merges every open layer below it too
   * (GitHub: "merge the top pull request, every pull request below it comes with it"), so without `--stack` the lower layer goes first, by itself;
   * with it (`viewer` set) every layer must hold its own gate and the top merges them all. */
  const mergeGate = (viewer, reviewed) => finishedPr(number, 'merge', undefined, () => viewer ? stackReasons(viewer) : readStacks()
    .flatMap(({ pull_requests: members = [] }) => members.slice(0, Math.max(0, members.findIndex(member => member.number === number)))
      .filter(member => member.state === 'open').map(member => `PR #${member.number} below it in its stack is still open: merge it first, merging this layer would merge it too`)), [], reviewed);

  /**
   * `stack-sync TOP` (#412): from the bottom layer up, merges the base of each layer of TOP's native stack into it and pushes it
   * (git merge, never a rebase or a force-push). It works in a temporary worktree, so no branch of the caller changes.
   * A real conflict stops it: the layer and the files are named, the merge stays open in the printed worktree.
   */
  function stackSync() {
    const fail = reason => { console.log(`FAILED\nblocker: ${reason}`); process.exitCode = 1; };
    const stacks = readStacks();
    if (stacks.length !== 1) return fail(`PR #${number} is ${stacks.length ? 'in several native stacks' : 'not in a native stack'}: stack-sync syncs one stack`);
    const open = stackMembers(stacks[0]).filter(member => member.state === 'open');
    if (open.at(-1)?.number !== number) return fail(`PR #${number} is not the top open layer of its stack${open.length ? ` (that is PR #${open.at(-1).number})` : ''}`);
    const git = externalTool('git', process.cwd(), projectDirectory);
    const run = (cwd, ...args) => execFileSync(git.file, ['-C', cwd, ...args], { encoding: 'utf8', env: git.env, stdio: 'pipe' }).trim();
    run(projectDirectory, 'fetch', 'origin');
    const tree = mkdtempSync(join(tmpdir(), 'stack-sync-'));
    run(projectDirectory, 'worktree', 'add', '--detach', tree, `origin/${open[0].head.ref}`);
    let base = `origin/${stacks[0].base.ref}`;
    let keep = false; // only a conflict leaves the worktree, for its resolution
    try {
      for (const layer of open) {
        run(tree, 'checkout', '--detach', `origin/${layer.head.ref}`);
        try { run(tree, 'merge', '--no-edit', base); } catch (error) {
          const files = run(tree, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
          if (!files.length) throw error;
          keep = true;
          return fail(`merging ${base} into PR #${layer.number} (${layer.head.ref}) conflicts in ${filesText(files)}; resolve and commit in ${tree}, push ${layer.head.ref}, then run stack-sync again`);
        }
        const synced = run(tree, 'rev-parse', 'HEAD') !== run(tree, 'rev-parse', `origin/${layer.head.ref}`);
        if (synced) run(tree, 'push', 'origin', `HEAD:refs/heads/${layer.head.ref}`);
        console.log(`PR #${layer.number} ${layer.head.ref}: ${synced ? 'merged and pushed' : 'already up to date'}`);
        base = run(tree, 'rev-parse', 'HEAD');
      }
      console.log(`DONE stack of PR #${number} is synced; CI starts on the pushed heads`);
    } finally {
      if (!keep) run(projectDirectory, 'worktree', 'remove', '--force', tree);
    }
  }

  return { stackBase, readStacks, stackState, stackReasons, mergeGate, stackSync };
}
