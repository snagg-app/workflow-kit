// `sweep`: closes issues whose PR is delivered.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createSweep(env) {
  const { graphql, isSpec, project, projectItem, restAll, statuses, texts } = env;
  const { resolveOption, writeOption } = env.later;

  /**
   * Human review means mergeable (docs/parallel-drivers.md): a Human-review issue whose open PR is DIRTY goes back to "Automated review" with a comment.
   * An open issue (never a spec) whose linked PR of this repository is merged into release/** is commented and closed as completed, unless a human reopened it after the merge.
   * ponytail: search cannot filter by Project status, so it reads every open issue (100 per page); UNKNOWN (still computing) waits for the next sweep.
   */
  function sweep() {
    let plan, resets = 0, read = 0;
    for (let after; ;) {
      const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:100,after:$after){
      issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{id number
      projectItems(first:100){nodes{id project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}
      labels(first:20){totalCount nodes{name}}
      closedByPullRequestsReferences(first:10,includeClosedPrs:true){totalCount nodes{number url state merged mergedAt baseRefName mergeStateStatus headRefName repository{nameWithOwner}}}}}}}`,
      { q: `repo:${project.repository} is:issue is:open`, ...(after && { after }) });
      for (const issue of search.nodes) {
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
          console.log(`#${issue.number} stays open: reopened ${reopened.created_at} after PR #${delivered.number} was merged`);
          resets++;
          continue;
        }
        if (delivered) {
          graphql('mutation($issue:ID!,$body:String!){addComment(input:{subjectId:$issue,body:$body}){clientMutationId}}', { issue: issue.id,
            body: texts.delivered(delivered.number, delivered.baseRefName) });
          graphql('mutation($issue:ID!){closeIssue(input:{issueId:$issue,stateReason:COMPLETED}){clientMutationId}}', { issue: issue.id });
          console.log(`#${issue.number} closed: delivered with PR #${delivered.number} in ${delivered.baseRefName}`);
          resets++;
          continue;
        }
        if (projectItem(issue)?.status?.name !== statuses.humanReview) continue;
        assert.ok(linked.totalCount <= linked.nodes.length, `#${issue.number} has more linked PRs than sweep reads; it would be reported clean`);
        const pr = own.find(node => node.state === 'OPEN' && node.mergeStateStatus === 'DIRTY');
        if (!pr) continue;
        plan ??= resolveOption('Status', statuses.automatedReview);
        // The comment first: a failed comment must not leave an issue out of Human review that nobody was told about.
        graphql('mutation($issue:ID!,$body:String!){addComment(input:{subjectId:$issue,body:$body}){clientMutationId}}', { issue: issue.id,
          body: texts.conflict(pr.url, statuses) });
        writeOption(issue, plan);
        console.log(`#${issue.number} reset to ${statuses.automatedReview}: PR #${pr.number} has merge conflicts`);
        resets++;
      }
      read += search.nodes.length;
      if (!search.pageInfo.hasNextPage) {
        assert.ok(read >= search.issueCount, `Search returned ${read} of ${search.issueCount} open issues; the sweep would be incomplete`);
        break;
      }
      assert.ok(search.pageInfo.endCursor && search.pageInfo.endCursor !== after, 'Search pagination did not advance');
      after = search.pageInfo.endCursor;
    }
    if (!resets) console.log('clean');
  }

  return { sweep };
}
