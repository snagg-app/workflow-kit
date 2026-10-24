// `sweep`: closes issues whose PR is delivered.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import assert from 'node:assert/strict';
import { result } from './board-result.mjs';
import { graphql, progress, project, restAll, statuses, texts } from './board-context.mjs';
import { isSpec, projectItem } from './board-common.mjs';
import { resolveOption, writeOption } from './board-fields.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'sweep', run: 'sweep', writes: true, doc: 'docs/board/sweep.md',
    summary: 'Cleans up the board. Human-review issues whose PR has merge conflicts go back to Automated review; issues whose PR merged into release/** are closed.' },
];

/**
 * Human review means mergeable (docs/parallel-drivers.md): a Human-review issue whose open PR is DIRTY goes back to "Automated review" with a comment.
 * An open issue (never a spec) whose linked PR of this repository is merged into release/** is commented and closed as completed, unless a human reopened it after the merge.
 * ponytail: search cannot filter by Project status, so it reads every open issue (100 per page); UNKNOWN (still computing) waits for the next sweep.
 */
function sweep() {
  let plan, resets = 0, read = 0;
  const closed = [], reset = [], skipped = [];
  for (let after; ;) {
    const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:100,after:$after){
    issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{id number
    projectItems(first:100){nodes{id project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}
    labels(first:20){totalCount nodes{name}}
    closedByPullRequestsReferences(first:10,includeClosedPrs:true){totalCount nodes{number url state merged mergedAt baseRefName mergeStateStatus headRefName repository{nameWithOwner}}}}}}}`,
    { q: `repo:${project.repository} is:issue is:open`, ...(after && { after }) });
    for (const issue of search.nodes) try {
      if (isSpec(issue)) continue;
      const linked = issue.closedByPullRequestsReferences;
      const own = linked.nodes.filter(node => node.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase());
      // GitHub closes an issue only for a merge into the default branch; a merge into release/** closes it here (comment first, then close).
      // ponytail: reads the first 10 linked PRs; a release PR behind them is missed, never an error.
      // A spec stays open until a human accepts it, however many of its tickets are delivered.
      const delivered = own.filter(node => node.merged && node.baseRefName.startsWith('release/'))
        .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)).at(-1);
      // A human reopened it after the latest merge: closing it again would undo that (#510). REST, only for the issues that would be closed.
      const reopened = delivered && restAll(`repos/${project.repository}/issues/${issue.number}/events`)
        .findLast(event => event.event === 'reopened' && Date.parse(event.created_at) > Date.parse(delivered.mergedAt));
      if (reopened) {
        progress(`#${issue.number} stays open: reopened ${reopened.created_at} after PR #${delivered.number} was merged`);
        continue;
      }
      if (delivered) {
        // A close that failed in an earlier run left the comment behind: write it once (REST read, only for the issues that would be closed).
        const body = texts.delivered(delivered.number, delivered.baseRefName);
        if (!restAll(`repos/${project.repository}/issues/${issue.number}/comments`).some(comment => comment.body === body))
          graphql('mutation($issue:ID!,$body:String!){addComment(input:{subjectId:$issue,body:$body}){clientMutationId}}', { issue: issue.id, body });
        graphql('mutation($issue:ID!){closeIssue(input:{issueId:$issue,stateReason:COMPLETED}){clientMutationId}}', { issue: issue.id });
        closed.push(issue.number);
        progress(`#${issue.number} closed: delivered with PR #${delivered.number} in ${delivered.baseRefName}`);
        resets++;
        continue;
      }
      if (projectItem(issue)?.status?.name !== statuses.humanReview) continue;
      assert.ok(linked.totalCount <= linked.nodes.length, `#${issue.number} has more linked PRs than sweep reads; it would be reported clean`);
      const pr = own.find(node => node.state === 'OPEN' && node.mergeStateStatus === 'DIRTY');
      if (!pr) continue;
      plan ??= resolveOption('Status', statuses.automatedReview);
      // The comment first: a failed comment must not leave an issue out of Human review that nobody was told about.
      // A status write that failed in an earlier run left the comment behind: write it once, like the delivered comment.
      const body = texts.conflict(pr.url, statuses);
      if (!restAll(`repos/${project.repository}/issues/${issue.number}/comments`).some(comment => comment.body === body))
        graphql('mutation($issue:ID!,$body:String!){addComment(input:{subjectId:$issue,body:$body}){clientMutationId}}', { issue: issue.id, body });
      writeOption(issue, plan);
      reset.push(issue.number);
      progress(`#${issue.number} reset to ${statuses.automatedReview}: PR #${pr.number} has merge conflicts`);
      resets++;
    } catch (error) {
      // A used-up quota would fail every further issue the same way: stop at once.
      if (error?.quotaUsedUp) throw error;
      // One issue sweep cannot judge or write must not stop the others; the run reports it and ends red.
      skipped.push(`#${issue.number} skipped: ${String(error?.message ?? error).split('\n')[0]}`);
    }
    read += search.nodes.length;
    if (!search.pageInfo.hasNextPage) {
      assert.ok(read >= search.issueCount, `Search returned ${read} of ${search.issueCount} open issues; the sweep would be incomplete`);
      break;
    }
    assert.ok(search.pageInfo.endCursor && search.pageInfo.endCursor !== after, 'Search pagination did not advance');
    after = search.pageInfo.endCursor;
  }
  const data = { closed, reset, skipped };
  if (skipped.length) return result('failed', 'FAILED', { headline: null, blockers: skipped, data });
  return resets ? result('ok', 'SWEPT', { headline: null, data }) : result('ok', 'CLEAN', { headline: 'clean', data });
}

export { sweep };
