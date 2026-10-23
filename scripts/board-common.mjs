// Reading helpers all commands share: the issue query, Project item, claims and texts.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** env: the project, the GitHub adapter, process and argument helpers and `later` (the other commands) */
export function createCommon(env) {
  const { github, graphql, issueName, issueOwner, issueProject, number, project, rest, restAll, statuses, texts } = env;

  // GitHub charges a query by its nested lists, not by what they return: every list inside a list (and every node of a list of
  // up to 100) multiplies the cost. So a query asks for little, and the rest is read only where a verdict needs it.
  // The PRs that close a predecessor (closed ones included, so a merged one stays visible; stackBase keeps open and merged) find the
  // base of a stack through the native closing links (manual ones included). They are read by loadDeliveries, only where a stack is judged.
  const predecessorFields = 'id number state stateReason repository{nameWithOwner}';
  const deliveryFields = `closedByPullRequestsReferences(first:10,includeClosedPrs:true){totalCount nodes{number state isDraft isCrossRepository repository{nameWithOwner} baseRefName headRefName headRefOid}}`;
  // "baseBranch": {"field": "Zielrelease", "pattern": "release/{value}", "values": {"main": "main"}} names the branch an issue starts from (#385);
  // `check` reads the field with the issue. The optional `values` give a fixed branch for those field values instead of the pattern (#403).
  const baseSetting = () => {
    const setting = issueProject.baseBranch;
    if (setting === undefined) return;
    assert.ok(typeof setting?.field === 'string' && setting.field.trim() && typeof setting.pattern === 'string' && setting.pattern.includes('{value}')
      && (setting.values === undefined || Object.values(setting.values ?? {}).every(branch => typeof branch === 'string' && branch.trim())),
      'baseBranch must be {"field": "<Project field>", "pattern": "<branch name containing {value}>", "values": {"<field value>": "<branch>"} (optional)}');
    return setting;
  };
  const baseField = (setting = baseSetting()) => setting ? ` base:fieldValueByName(name:${JSON.stringify(setting.field)}){...on ProjectV2ItemFieldSingleSelectValue{name} ...on ProjectV2ItemFieldTextValue{text}}` : '';
  // Everything the verdict reads; sub-issues carry the same fields, so their verdict needs no further query.
  const issueFields = predecessor => `id number title state body updatedAt repository{nameWithOwner} assignees(first:10){nodes{login}}
  projectItems(first:100){nodes{id project{id} updatedAt status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}${baseField()}}}
  blockedBy(first:100){totalCount nodes{${predecessor}}}`;
  // The login of the viewer comes along, so the own-work check needs no query of its own. Sub-issues (only `check` lists them) are asked
  // for in the number given: each costs three lists, so the first page is short and a longer list is read again at 100.
  // ponytail: closedByPullRequestsReferences lists open PRs with a closing link only (a plain mention is none); sub-issues stop at 100, shown with a note.
  // `refs` finds the branches `<agent>/<number>-…` of the issue: a name filter on one flat list, no nested list.
  const issueQuery = subIssues => `query($owner:String!,$name:String!,$number:Int!,$branch:String!){viewer{login} repository(owner:$owner,name:$name){
  refs(refPrefix:"refs/heads/",query:$branch,first:20){nodes{name}}
  issue(number:$number){
  ${issueFields(predecessorFields)}
  closedByPullRequestsReferences(first:100){totalCount nodes{number state body updatedAt mergeStateStatus repository{nameWithOwner} headRefName}}
  labels(first:20){totalCount nodes{name}}
  comments(last:50){nodes{${feedbackNode}}}
  ${subIssues ? `subIssues(first:${subIssues}){totalCount nodes{${issueFields('number state stateReason repository{nameWithOwner}')}}}` : ''}}}}`;

  /** Names the issue in failures (a bare "Could not resolve to an Issue" hides which repository was meant). */
  const named = (label, read) => {
    try { return read(); } catch (error) { throw new Error(`${label}: ${String(error.stderr || error.message).trim()}`, { cause: error }); }
  };
  const readIssue = (withSubIssues = false, at = number) => named(`${issueProject.repository}#${at}`, () => {
    for (let first = withSubIssues && 30; ; first = 100) {
      const { viewer, repository } = graphql(issueQuery(first), { owner: issueOwner, name: issueName, number: at, branch: `/${at}-` });
      const issue = repository.issue ?? assert.fail('issue not found');
      if (!(issue.subIssues?.totalCount > issue.subIssues?.nodes.length) || first >= 100) return { ...issue, viewer, branches: repository.refs?.nodes ?? [] };
    }
  });

  /** Reads the PRs that close the predecessors that have none loaded yet, 100 predecessors per query (a lookup by id is any repository). */
  function loadDeliveries(predecessors) {
    const missing = predecessors.filter(predecessor => !predecessor.closedByPullRequestsReferences);
    const ids = [...new Set(missing.map(predecessor => predecessor.id))];
    for (let from = 0; from < ids.length; from += 100) {
      const batch = ids.slice(from, from + 100);
      // The assignees ride along for the blocker line of `check` (predecessorLine); they are not part of predecessorFields, which every `next` list repeats.
      const { nodes } = graphql(`query{nodes(ids:${JSON.stringify(batch)}){...on Issue{${deliveryFields} assignees(first:5){nodes{login}}}}}`);
      // The same predecessor can hold several issues: every object of it gets the list. An unreadable one stays without it,
      // which stackBase reports as unreadable, never as "no PR".
      batch.forEach((id, index) => missing.filter(predecessor => predecessor.id === id)
        .forEach(predecessor => {
          predecessor.closedByPullRequestsReferences = nodes[index]?.closedByPullRequestsReferences;
          predecessor.assignees = nodes[index]?.assignees;
        }));
    }
  }

  const projectItem = issue => issue.projectItems.nodes.find(item => item.project.id === issueProject.id);
  // Existing boards use either spelling; unknown statuses keep their value and fail closed.
  const statusName = name => String(name).toLowerCase() === 'auto review' ? statuses.automatedReview : name;
  const projectStatus = issue => statusName(projectItem(issue)?.status?.name);
  // "specLabel" in the project file (default "spec") marks a spec. Only a human closes a spec or sets it to Done (AGENT_RULES.md, Hard rules).
  const { specLabel } = project;
  function isSpec(issue) {
    const labels = issue.labels;
    if (!labels) return false;
    assert.ok(Array.isArray(labels.nodes) && labels.nodes.every(label => typeof label?.name === 'string'), 'Issue labels are unreadable');
    assert.ok(labels.totalCount === undefined || (Number.isSafeInteger(labels.totalCount) && labels.totalCount >= labels.nodes.length), 'Issue label count is unreadable');
    if (labels.nodes.some(label => label.name.toLowerCase() === specLabel.toLowerCase())) return true;
    if (labels.totalCount > labels.nodes.length) {
      const all = restAll(`repos/${issueProject.repository}/issues/${issue.number}/labels`);
      assert.ok(all.length === labels.totalCount && all.every(label => typeof label?.name === 'string'), 'Not every issue label is readable; retry the read');
      labels.nodes = all;
      return all.some(label => label.name.toLowerCase() === specLabel.toLowerCase());
    }
    return false;
  }

  const specRefusal = (issueNumber, what) => `BLOCKED: #${issueNumber} is a spec (label "${specLabel}"); ${what}. Only a human closes a spec or sets Done; record the acceptance in a comment on the spec (AGENT_RULES.md, Hard rules).`;

  /** A conflict in a lower layer locks the whole native stack, so it is a blocker (#412, undoes #405). This is the order that fixes it; `stack-sync` does it. */
  const stackOrderText = 'merge the base into the lowest layer, then each layer into the next one up (merge, never rebase or force-push); `board.mjs stack-sync TOP` does it for the stack';

  /** Git's Regeln für Ref-Namen (git check-ref-format): jeder gültige Tag wird nachgeschlagen, kein ungültiger. */
  const validTagName = tag => tag !== '' && !/[\x00-\x1f\x7f ~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$/u.test(tag)
    && tag.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));

  /**
   * Zeilen `Wartet bis: <Tag | JJJJ-MM-TTThh:mmZ | Entscheidung NAME>` im Issue-Text (üblich unter "Abhängigkeiten und Wiederaufnahme"): ein
   * fehlender Tag oder ein künftiger UTC-Zeitpunkt hält das Issue wie ein nativer Blocker; was nicht lesbar ist, zählt als
   * unbekannt, nie als frei. Bewusst ohne Markdown-Abschnittslogik: jede solche Zeile zählt, auch in Code oder unter anderer
   * Überschrift. Ein Fehlgriff blockiert sichtbar (mit Grund), statt eine Bedingung still zu überlesen.
   */
  const decisionWait = 'waits for the decision of';
  // The claim (#643) is "Agent: claude|codex, Session: ID": `start` writes it as an issue comment (with "Basis: BRANCH"); once the first push opens the Draft PR, the PR body carries it
  // and decides. The field may stand anywhere in a line
  // (Codex wrote it at the end of a sentence), not quoted in code, and "Agent: codex" alone is the claim of an unknown session: it can never be
  // the caller's, so it holds the issue until the line in the PR body is edited to the new session (a handover).
  const claimField = /(?<![\w`])Agent:[ \t]*(claude|codex)(?![\w-])(?:[ \t]*,[ \t]*Session:[ \t]*(\w[\w.-]*)(?![\w.-]))?/i;
  const claimOf = pr => claimField.exec(pr.body ?? '');

  /** Claim comments of the issue, oldest first; a reply line without a session is no claim. ponytail: reads the comments the query holds (the newest 50 of an issue, 10 in lists). */
  const commentClaims = issue => (issue.comments?.nodes ?? []).map(comment => claimField.exec(comment.body)).filter(found => found?.[2]);
  // Feedback after a handoff (#554): issue comments ride along with the searches; PR feedback is read by actual ids,
  // so two connections per PR do not multiply every search slot by ten hypothetical PRs.
  const feedbackNode = 'createdAt url body';
  const issueFeedback = `comments(last:10){nodes{${feedbackNode}}}`;
  const handoffHeading = new RegExp(`^## ${RegExp.escape(texts.handoff)}\\s*$`, 'm'), replyLine = /^Agent:[ \t]*(claude|codex)\b/im;
  // #N in the project's repository, OWNER/REPO#N elsewhere: a bare number must never name a same-number issue or PR of another repository.
  const refOf = (repository, number) => `${repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase() ? '' : repository.nameWithOwner}#${number}`;
  const logins = issue => issue.assignees.nodes.map(assignee => assignee.login).join(', ');
  const ago = ms => {
    const minutes = Math.max(0, Math.floor(ms / 60_000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  };
  // Reviewers run unreliably, so only traces on the current head count (docs/CONTRIBUTING.md#review-loop).
  // GitHub charges a query by its connections: each of the up to 100 review threads and check suites counts one more. 30 suites keep the whole read at 1 point instead of 2; a longer list is read again at 100.
  const prQuery = suites => `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  number state isDraft createdAt headRefName headRefOid baseRefName mergeStateStatus reviewDecision isCrossRepository headRepository{nameWithOwner} body${project.selfReview.length ? ' bodyHTML' : ''}
  readyEvents:timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  firstReadyEvents:timelineItems(first:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  convertEvents:timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}
  latestOpinionatedReviews(first:100){totalCount nodes{state author{login}}}
  reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{url}}}}
  closingIssuesReferences(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id}}
  commits(last:1){nodes{commit{oid committedDate checkSuites(first:${suites}){totalCount nodes{createdAt status conclusion app{slug} workflowRun{databaseId workflow{id}} checkRuns(first:1){totalCount}}}
    statusCheckRollup{contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{name status conclusion title summary detailsUrl startedAt completedAt checkSuite{databaseId createdAt app{slug} workflowRun{databaseId event workflow{id name}}}}
      ...on StatusContext{context state description createdAt creator{login}}}}}}}}
  reviewRequests(first:100){totalCount nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{name}}}}
  requestEvents:timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT]){totalCount nodes{...on ReviewRequestedEvent{createdAt
    requestedReviewer{...on User{login} ...on Bot{login} ...on Team{name}}}}}}}}`;
  // ponytail: checks, check suites, review requests and opinionated reviews stop at 100 with ERROR, never a wrong verdict; paginate when a project gets there.
  const lines = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  // ponytail: relies on GitHub's markup (h1-h6, li, issue-link); replace when GitHub changes it.
  const text = html => html.replace(/<\/?(?:br|p|div|li|h[1-6]|ul|ol|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

  /** Metadata that can still describe the previous push right after it: identity, branch, state, draft, head. */
  const readyQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  id number state isDraft isCrossRepository headRefOid headRepository{nameWithOwner}}}}`;

  /** What the last query cost and what is left, so a driver sees the shared quota without a command of its own. */
  const quotaLine = () => github.quota && `quota: ${github.quota.remaining} left, ${github.spent} reported GraphQL wrapper points, ${github.calls} wrapper calls, resets ${github.quota.resetAt}`;
  const sameLogin = (a, b) => a?.toLowerCase() === b?.toLowerCase();

  let defaultBranch;
  const defaultBranchName = () => defaultBranch ??= rest(`repos/${project.repository}`).default_branch;

  return { predecessorFields, deliveryFields, baseSetting, baseField, issueFields, issueQuery, named, readIssue, loadDeliveries, projectItem, statusName, projectStatus, specLabel, isSpec, specRefusal, stackOrderText, validTagName, decisionWait, claimField, claimOf, commentClaims, feedbackNode, issueFeedback, handoffHeading, refOf, logins, ago, prQuery, lines, text, readyQuery, quotaLine, sameLogin, defaultBranch, defaultBranchName, defaultBranchName, replyLine };
}
