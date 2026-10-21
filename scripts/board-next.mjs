// `next`: the issues an agent may start.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';

import { shared } from './board-args.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'next', run: 'next', doc: 'docs/board/next.md', flags: { '--session': shared.session },
    summary: 'Lists what to do next. In this order: feedback on your issues, your unfinished work, stale work, the Ready issues.' },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createNext(env) {
  const { ago, baseField, commentClaims, graphql, issueFeedback, loadDeliveries, predecessorFields, project, projectItem, projectStatus, restAll, sessionOption, statuses } = env;
  const { conflicting, dropFieldsCache, feedback, heldOnlyByOpenPredecessors, idleMs, isStale, loadPrFeedback, openPr, ownWork, predecessorReasons, selectField, stackBase, startReasons, waitReasons } = env.later;

  function next() {
    // Advanced issue search understands -is:blocked (open native predecessors). Separate searches keep blocked issues
    // from crowding unblocked ones out of the 1,000-result search cap; read every page of both before sorting. A page costs by its size, not by its hits
    // so it is short. PR feedback is loaded separately, once per actual unique PR.
    // The open PRs (state, update time, merge state) and the update times tell abandoned work from live work (#400); the viewer finds the own.
    const nodes = [];
    let login;
    for (const blocking of ['-is:blocked', 'is:blocked']) for (let after, read = 0; ;) {
      const { search, viewer } = graphql(`query($q:String!,$after:String){viewer{login} search(query:$q,type:ISSUE_ADVANCED,first:30,after:$after){
      issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{number title body updatedAt assignees(first:10){nodes{login}} ${issueFeedback}
      blockedBy(first:100){totalCount nodes{${predecessorFields}}}
      issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}
      closedByPullRequestsReferences(first:10){nodes{number state body updatedAt mergeStateStatus headRefName repository{nameWithOwner} id}}
      projectItems(first:100){nodes{project{id} updatedAt status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}${baseField()}
        priority:fieldValueByName(name:"Priority"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}`,
      { q: `repo:${project.repository} is:issue is:open ${blocking}`, ...(after && { after }) });
      login = viewer.login;
      nodes.push(...search.nodes);
      read += search.nodes.length;
      if (!search.pageInfo.hasNextPage) {
        assert.ok(read >= search.issueCount, `Search returned ${read} of ${search.issueCount} ${blocking} issues; the list would be incomplete`);
        break;
      }
      assert.ok(search.pageInfo.endCursor && search.pageInfo.endCursor !== after, 'Search pagination did not advance');
      after = search.pageInfo.endCursor;
    }
    loadPrFeedback(nodes);
    // The Priority field's option order is the ranking, whatever the scale (High/Low, P0/P1, …).
    dropFieldsCache(); // the ranking is the option order: never from the cache
    const rank = selectField('Priority').choices.map(choice => choice.name);
    const order = priority => rank.includes(priority) ? rank.indexOf(priority) : rank.length;
    const ready = nodes.map(issue => ({ ...issue, item: projectItem(issue) }))
      .filter(issue => issue.item?.status?.name === statuses.ready)
      .map(issue => {
        const predecessors = predecessorReasons(issue.blockedBy), waits = waitReasons(issue.body);
        return { ...issue, predecessors, reasons: [...predecessors.blocked, ...waits.blocked, ...predecessors.unknown, ...waits.unknown], priority: issue.item.priority?.name
          ?? issue.issueFieldValues.nodes.find(field => field.field?.name === 'Priority')?.name };
      })
      .sort((a, b) => order(a.priority) - order(b.priority) || a.number - b.number);
    // An open PR or a branch holds an issue as in `check` (#497): read for the issues that would start or stack otherwise (REST only: one branch list).
    let branches;
    for (const issue of ready.filter(issue => !issue.reasons.length || heldOnlyByOpenPredecessors(issue.reasons, issue.predecessors))) try {
      branches ??= restAll(`repos/${project.repository}/branches`);
      issue.reasons.push(...startReasons({ ...issue, branches, viewer: { login } }, sessionOption()).blocked);
    } catch (error) { issue.reasons.push(`branches are unreadable: ${String(error.stderr || error.message).trim()}`); }
    const line = issue => `#${issue.number} [${issue.priority ?? 'no priority'}] ${issue.title}`
      + ` (assignees: ${issue.assignees.nodes.map(assignee => assignee.login).join(', ') || 'none'})`;
    const startable = ready.filter(issue => !issue.reasons.length);
    // Held only by open predecessors that one open PR delivers: stackable on that PR.
    const candidates = ready.filter(issue => issue.reasons.length && heldOnlyByOpenPredecessors(issue.reasons, issue.predecessors));
    loadDeliveries(candidates.flatMap(issue => issue.predecessors.open));
    const stackable = candidates.map(issue => ({ ...issue, base: stackBase(issue.predecessors.open).pr })).filter(issue => issue.base);
    const held = ready.filter(issue => issue.reasons.length && !stackable.some(candidate => candidate.number === issue.number));
    // Unfinished work comes first: the own (finish it before a new start), then work that nobody moves (a stale PR, a Human-review PR with conflicts),
    // which a new session may take over (start ISSUE --session ID).
    const status = projectStatus;
    const session = sessionOption(), mine = session ? ownWork(nodes, login, session) : [];
    const abandoned = nodes.filter(issue => [statuses.inProgress, statuses.automatedReview, statuses.humanReview].includes(status(issue)) && !mine.includes(issue) && (openPr(issue) || commentClaims(issue).length) && isStale(issue));
    const work = (issue, note) => `#${issue.number} [${status(issue)}] ${issue.title} (PR #${openPr(issue)?.number ?? '-'}${note ? `, ${note}` : ''})`;
    const replies = nodes.map(issue => ({ issue, ...feedback(issue, login, session) })).filter(row => row.reason);
    if (replies.length) console.log(`Rückmeldungen (answer in the ticket with a comment that starts with your "Agent: …, Session: …" line, or hand off again with done; start ISSUE is BLOCKED while one of your session's is open):\n${replies.map(row => `#${row.issue.number} [${status(row.issue)}] ${row.issue.title}: ${row.reason} ${row.url}`).join('\n')}\n`);
    if (mine.length) console.log(`Finish your own work first (start ISSUE is BLOCKED for a new start meanwhile):\n${mine.map(issue => work(issue)).join('\n')}\n`);
    if (abandoned.length) console.log(`Stale or conflicting work, a new session may take it over (start ISSUE --session ID):\n${abandoned.map(issue => work(issue,
      conflicting(issue) ? 'merge conflicts' : `no activity for ${ago(idleMs(issue))}`)).join('\n')}\n`);
    for (const issue of startable) console.log(line(issue));
    console.log(startable.length ? 'Run board.mjs start ISSUE to take one.' : 'No Ready issue whose blockers are all completed.');
    if (stackable.length) console.log('\nReady and stackable on an open PR (start ISSUE says STACKABLE; see docs/CONTRIBUTING.md#stacked-pull-requests):');
    for (const issue of stackable) console.log(`${line(issue)}\n  - base PR #${issue.base.number} (${issue.base.state === 'MERGED' ? `merged into ${issue.base.baseRefName}` : `branch ${issue.base.headRefName}`})`);
    if (held.length) console.log('\nReady but not startable:');
    for (const issue of held) console.log([line(issue), ...issue.reasons.map(reason => `  - ${reason}`)].join('\n'));
  }

  return { next };
}
