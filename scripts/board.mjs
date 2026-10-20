// Board commands, so agents don't rediscover Project, priority and dependency APIs on every task.
// Run in the project: board.mjs start | done | next | sweep | field | new | block | sub | wait | quota-wait | merge | stack-sync | body | body-replace (see usage below).
// `--cwd PATH` as the first argument runs it for the project in PATH from any directory: without it the
// working directory decides the project, and a driver in another project would read and write the wrong board.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalTool, projectRoot, takeCwd } from './checkout-root.mjs';
import { isRateLimited, quotaOf, retryAt, splitResponse, untilText, waitInterval } from './quota.mjs';

// Taken off here: the commands below read their arguments by position.
// A subfolder of the checkout (or of --cwd) works like its root: the project file is found there.
const startDirectory = takeCwd();
let projectDirectory;
try { projectDirectory = projectRoot(startDirectory); } catch (error) {
  // Only the two expected misses get a short line; any other failure (EACCES, ELOOP) keeps its own message.
  const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
  if (!missing && error.code !== 'ERR_ASSERTION') throw error;
  console.error(`${startDirectory}: ${missing ? 'is not a directory' : 'is not inside a Git checkout'}`);
  process.exit(2);
}
const [command, ref, typed] = process.argv.slice(2);
const projectFile = join(projectDirectory, '.github/workflow-project.json');
if (!existsSync(projectFile)) {
  console.error(`${projectFile} is missing: run board.mjs inside the project, or name it with --cwd PROJECT_DIR`);
  process.exit(2);
}
const project = JSON.parse(readFileSync(projectFile, 'utf8'));
const [owner, name] = project.repository.split('/');
// `new` has no issue yet and assigns the number it creates.
let number = Number(String(ref).replace(/^#/, ''));
const gh = externalTool('gh', process.cwd(), projectDirectory);

/**
 * git in the project's checkout (--cwd, else the working directory); looked up on use, so commands without git never need one.
 * Worktrees of one clone share their remote refs: a `fetch` that meets another's lock on a ref ("cannot lock ref", #566) is repeated
 * after a second, three tries in all; any other failure stays one at once.
 */
function git(...args) {
  const tool = externalTool('git', process.cwd(), projectDirectory);
  for (let attempt = 1; ; attempt++) {
    try {
      const output = execFileSync(tool.file, ['-C', projectDirectory, ...args], { encoding: 'utf8', env: tool.env, stdio: ['ignore', 'pipe', 'pipe'] });
      return args.includes('-z') ? output : output.trim();
    } catch (error) {
      if (args[0] !== 'fetch' || attempt === 3 || !/cannot lock ref|unable to update local ref/.test(String(error.stderr || error.message))) throw error;
      sleep(1);
    }
  }
}

/** The commit the project's checkout (--cwd, else the working directory) has checked out: what `done` expects the PR to show. */
function localHead() {
  try {
    return git('rev-parse', 'HEAD');
  } catch (error) {
    console.error(`ready --local cannot read the head of ${projectDirectory}: ${String(error.stderr || error.message).trim()}`);
    process.exit(2);
  }
}
// The first argument after the PR; `ready PR --local` (the step `done` takes) reads the head from the checkout, so a shell never has to splice `$(git rev-parse HEAD)` into the call.
// The PR must still show exactly that head before it is marked ready, so a commit that was not pushed is refused like a mistyped id.
// `done` sets it to the PR it found, so the handoff steps it calls read their PR where they read it for a called `handoff`.
let value = command === 'ready' && typed === '--local' && Number.isSafeInteger(number) ? localHead() : typed;

// The account's GraphQL quota (5000 points an hour) is shared by every agent on it. Every response carries what is left and when it
// resets in its headers (`gh api -i`, also on a refusal), so no extra request asks for it; a query reads its own cost.
// wait, reviews and handoff sleep until the reset instead of failing when it runs out or falls below their reserve;
// every other command stops with the reset time.
const sleepers = { wait: 300, reviews: 50, handoff: 50, done: 50, 'quota-wait': 300 };
let quota, spent = 0, graphqlCalls = 0; // the latest quota, this run's reported cost and actual request count
// `wait` gives up at this time (--max-minutes), before the 10-minute limit of an agent's shell tool would push it into the background.
let deadline = Infinity;
const startedAt = Date.now();
/** A quota pause that would end after the deadline: `wait` ends "still waiting" instead of sleeping through it. */
class StillWaiting extends Error {
  constructor(resetAt) { super('still waiting'); this.resetAt = resetAt; }
}

/** The quota is used up until `resetAt`: `wait` does not sleep through it but keeps looking over REST (pausedRound). */
class QuotaPause extends Error {
  constructor(resetAt) { super('quota pause'); this.resetAt = resetAt; }
}

/** Say so in one line (stderr keeps stdout for the verdict) and sleep until the reset. */
function sleepUntilReset(resetAt) {
  if (command === 'wait') throw new QuotaPause(resetAt);
  if (Date.parse(resetAt) > deadline) throw new StillWaiting(resetAt);
  console.error(`rate limited until ${untilText(resetAt)}`);
  sleep(Math.max(1, (Date.parse(resetAt) - Date.now()) / 1000 + 1));
}

/**
 * One GraphQL request. `tolerate` is a pattern for a failure whose partial answer is still wanted (one of several aliased mutations
 * failed): gh then exits non-zero, but the data of the others is in its output. `beforeSend` runs after pauses, on every attempt.
 */
function graphql(query, variables = {}, tolerate, beforeSend) {
  // Organization-linked Priority fields live on the issue and need this preview header.
  const args = ['api', 'graphql', '-i', '-H', 'GraphQL-Features: issue_fields', '-f',
    `query=${query.startsWith('query') ? `${query.slice(0, query.lastIndexOf('}'))} rateLimit{cost}}` : query}`];
  for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
  for (let sleeps = 0; ; sleeps++) {
    if (command in sleepers && quota?.remaining < sleepers[command] && Date.parse(quota.resetAt) > Date.now()) sleepUntilReset(quota.resetAt);
    try {
      beforeSend?.();
      graphqlCalls++;
      // stderr piped: a tolerated refusal ("already exists") is no failure, and a real one reaches the error message.
      const response = execFileSync(gh.file, args, { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, stdio: 'pipe' });
      const { headers, body } = splitResponse(response);
      const { data, errors } = JSON.parse(body);
      quota = quotaOf(headers) ?? quota;
      spent += data?.rateLimit?.cost ?? (query.startsWith('mutation') ? 1 : 0);
      if (errors?.length) {
        const message = errors.map(({ type, message }) => `${type ?? ''} ${message ?? ''}`).join('\n').trim();
        if (!(tolerate?.test(message) && data)) throw Object.assign(new Error(message), { stdout: response, stderr: message });
      }
      return data;
    } catch (error) {
      const text = `${error.stderr}${error.stdout}`, { headers, body } = splitResponse(error.stdout);
      if (tolerate?.test(text)) {
        let partial;
        try { partial = JSON.parse(body).data; } catch { /* no usable answer: the error below */ }
        if (partial) return partial;
      }
      if (!isRateLimited(text)) throw error;
      quota = quotaOf(headers) ?? quota;
      // A primary refusal whose own headers show free quota is stale (the window reset meanwhile): ask again now, never wait for a reset time.
      if (!/secondary rate limit/i.test(text) && quota?.remaining > 0 && quotaOf(headers)) {
        assert.ok(sleeps < 3, `GitHub keeps refusing although its headers report ${quota.remaining} points left; run ${command} again later`);
        continue;
      }
      // The refusal names its own reset; without headers, a minute from now.
      const resetAt = retryAt(text, sleeps, () => quotaOf(headers)?.resetAt ?? new Date(Date.now() + 60_000).toISOString(), Date.now(), headers);
      assert.ok(command in sleepers && sleeps < 3, `The GitHub GraphQL quota is used up until ${untilText(resetAt)}; run ${command} again after that`);
      sleepUntilReset(resetAt);
    }
  }
}

// GitHub charges a query by its nested lists, not by what they return: every list inside a list (and every node of a list of
// up to 100) multiplies the cost. So a query asks for little, and the rest is read only where a verdict needs it.
// The PRs that close a predecessor (closed ones included, so a merged one stays visible; stackBase keeps open and merged) find the
// base of a stack through the native closing links (manual ones included). They are read by loadDeliveries, only where a stack is judged.
const predecessorFields = 'id number state stateReason repository{nameWithOwner}';
const deliveryFields = `closedByPullRequestsReferences(first:10,includeClosedPrs:true){totalCount nodes{number state isDraft isCrossRepository repository{nameWithOwner} baseRefName headRefName headRefOid}}`;
// "baseBranch": {"field": "Zielrelease", "pattern": "release/{value}", "values": {"main": "main"}} names the branch an issue starts from (#385);
// `check` reads the field with the issue. The optional `values` give a fixed branch for those field values instead of the pattern (#403).
const baseSetting = () => {
  const setting = project.baseBranch;
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
  ${subIssues ? `subIssues(first:${subIssues}){totalCount nodes{${issueFields('number state stateReason repository{nameWithOwner}')}}}` : ''}}}}`;
/** Names the issue in failures (a bare "Could not resolve to an Issue" hides which repository was meant). */
const named = (label, read) => {
  try { return read(); } catch (error) { throw new Error(`${label}: ${String(error.stderr || error.message).trim()}`, { cause: error }); }
};
const readIssue = (withSubIssues = false, at = number) => named(`${project.repository}#${at}`, () => {
  for (let first = withSubIssues && 30; ; first = 100) {
    const { viewer, repository } = graphql(issueQuery(first), { owner, name, number: at, branch: `/${at}-` });
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
const projectItem = issue => issue.projectItems.nodes.find(item => item.project.id === project.id);
// Existing boards use either spelling; unknown statuses keep their value and fail closed.
const statusName = name => String(name).toLowerCase() === 'auto review' ? 'Automated review' : name;
const projectStatus = issue => statusName(projectItem(issue)?.status?.name);

// "specLabel" in the project file (default "spec") marks a spec. Only a human closes a spec or sets it to Done (AGENT_RULES.md, Hard rules).
const specLabel = project.specLabel === undefined ? 'spec' : project.specLabel;
assert.ok(typeof specLabel === 'string' && specLabel.trim(), 'specLabel in .github/workflow-project.json must be a label name; omit the field for "spec"');
function isSpec(issue) {
  const labels = issue.labels;
  if (!labels) return false;
  assert.ok(Array.isArray(labels.nodes) && labels.nodes.every(label => typeof label?.name === 'string'), 'Issue labels are unreadable');
  assert.ok(labels.totalCount === undefined || (Number.isSafeInteger(labels.totalCount) && labels.totalCount >= labels.nodes.length), 'Issue label count is unreadable');
  if (labels.nodes.some(label => label.name.toLowerCase() === specLabel.toLowerCase())) return true;
  if (labels.totalCount > labels.nodes.length) {
    const all = restAll(`repos/${project.repository}/issues/${issue.number}/labels`);
    assert.ok(all.length === labels.totalCount && all.every(label => typeof label?.name === 'string'), 'Not every issue label is readable; retry the read');
    labels.nodes = all;
    return all.some(label => label.name.toLowerCase() === specLabel.toLowerCase());
  }
  return false;
}
const specRefusal = (issueNumber, what) => `BLOCKED: #${issueNumber} is a spec (label "${specLabel}"); ${what}. Only a human closes a spec or sets Done; record the acceptance in a comment on the spec (AGENT_RULES.md, Hard rules).`;

/** Specs are untouched outside a human-invoked spec-review; re-read children immediately before Human review. */
function guardSpecStatus(issue, { fieldName, option }) {
  if (fieldName !== 'Status' || !isSpec(issue)) return;
  assert.ok(option.name !== 'Done', specRefusal(issue.number, 'Status Done is refused'));
  assert.ok(command === 'field' && process.argv.includes('--spec-review'), specRefusal(issue.number, 'only a human-invoked spec-review changes its status; field requires --spec-review'));
  if (option.name === 'Human review') {
    const children = restAll(`repos/${project.repository}/issues/${issue.number}/sub_issues`);
    assert.ok(children.every(child => Number.isSafeInteger(child?.number) && ['open', 'closed'].includes(child.state)), 'Spec sub-issues are unreadable');
    const open = children.filter(child => child.state === 'open');
    assert.ok(!open.length, specRefusal(issue.number, `Human review is refused: open sub-issues ${open.map(child => `#${child.number}`).join(', ')}`));
  }
}

// "staleHours" in the project file (default 6): after that long without activity the work counts as abandoned and a new session may take it over (#400).
const staleHours = project.staleHours === undefined ? 6 : project.staleHours;
/**
 * Milliseconds since the last activity: the newest of the issue (comments), its Project item (status) and its open PR (push, comments, reviews),
 * all read with the issue anyway. undefined when GitHub gave no time.
 * ponytail: PR activity includes bot comments, so a PR that a bot keeps touching never goes stale; replace with the newest commit date of the PR head if that bites.
 */
function idleMs(issue) {
  const prs = openPrs(issue);
  const times = [issue.updatedAt, projectItem(issue)?.updatedAt, ...prs.map(pr => pr.updatedAt)].map(time => Date.parse(time)).filter(Number.isFinite);
  return times.length ? Date.now() - Math.max(...times) : undefined;
}
const openPr = issue => issue.closedByPullRequestsReferences?.nodes.find(pr => pr?.state === 'OPEN' && pr.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase());
/** The open PRs that use this branch as their base: a PR with such a dependent is a lower layer of a stack. */
function dependentPrs(branch) {
  const dependents = rest(`repos/${project.repository}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`);
  assert.ok(Array.isArray(dependents), 'The open PRs on the branch are unreadable');
  return dependents;
}
/** A conflict in a lower layer locks the whole native stack, so it is a blocker (#412, undoes #405). This is the order that fixes it; `stack-sync` does it. */
const stackOrderText = 'merge the base into the lowest layer, then each layer into the next one up (merge, never rebase or force-push); `board.mjs stack-sync TOP` does it for the stack';
/** The blocker line for conflicts; a PR that has a PR on top of it is a lower layer and gets the order. Read only for a DIRTY PR, an unreadable lookup keeps the plain conflict. */
const conflictLine = pr => {
  let lower = false;
  try { lower = dependentPrs(pr.headRefName).length > 0; } catch { /* the plain verdict stands */ }
  return `blocker: merge conflicts${lower ? ` in a lower stack layer, which locks the whole stack: ${stackOrderText}` : ''}`;
};
const conflicting = issue => projectItem(issue)?.status?.name === 'Human review' && openPr(issue)?.mergeStateStatus === 'DIRTY';
/** Abandoned: no activity for staleHours, or a Human-review PR with conflicts (it is not mergeable, so nobody finishes it). Work on such an issue has expired. */
const isStale = (issue, idle = idleMs(issue)) => idle > staleHours * 3_600_000 || conflicting(issue);
const openPrs = issue => (issue.closedByPullRequestsReferences?.nodes ?? []).filter(pr => pr?.state === 'OPEN');
const workBranches = issue => (issue.branches ?? []).map(branch => branch.name).filter(name => new RegExp(`^[\\w.-]+/${issue.number}-`).test(name));

/** Why native predecessors still hold an issue: open, closed without delivery, or unreadable. */
function predecessorReasons({ totalCount, nodes }) {
  const blocked = [], unknown = [], open = [];
  const readable = nodes.filter(Boolean);
  if (readable.length < totalCount) unknown.push(`only ${readable.length} of ${totalCount} predecessors are readable`);
  for (const predecessor of readable) {
    const label = `${predecessor.repository.nameWithOwner}#${predecessor.number}`;
    if (predecessor.state === 'OPEN') { blocked.push(`blocked by ${label} (open)`); open.push(predecessor); }
    else if (!predecessor.stateReason) unknown.push(`${label} is closed without a readable reason`);
    // Only a completed predecessor delivered; not planned or duplicate needs a recorded decision.
    else if (predecessor.stateReason !== 'COMPLETED') {
      const reason = predecessor.stateReason.toLowerCase().replace('_', ' ');
      blocked.push(`blocked by ${label} (closed as ${reason}; record a decision)`);
    }
  }
  return { blocked, unknown, open };
}

/** The current local PR of an issue, or why linked-PR data cannot safely identify one. */
function currentIssuePr(issue) {
  const linked = issue.closedByPullRequestsReferences;
  if (!Number.isSafeInteger(linked?.totalCount) || linked.totalCount < 0 || !Array.isArray(linked.nodes)
    || linked.nodes.length !== linked.totalCount || linked.nodes.some(pr => !pr)) {
    return { unknown: 'the linked PRs of this issue are not completely readable' };
  }
  const open = [];
  for (const pr of linked.nodes) {
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)) return { unknown: 'an issue-linked PR has unreadable state' };
    if (pr.state !== 'OPEN') continue;
    const repository = pr.repository?.nameWithOwner;
    if (typeof repository !== 'string') return { unknown: `the repository of open PR #${pr.number ?? '?'} is unreadable` };
    if (repository.toLowerCase() !== project.repository.toLowerCase()) continue;
    if (!Number.isSafeInteger(pr.number) || pr.number < 1) return { unknown: 'an open issue-linked PR has unreadable number' };
    open.push(pr);
  }
  if (open.length > 1) return { unknown: `the issue has multiple open PRs in ${project.repository}` };
  return { number: open[0]?.number };
}

/** A partial PR only mentions the issue (`Refs #N`, no closing link) while exactly one other open PR closes it: it has its own gate and never moves the issue's status. */
const isPartialPr = (issue, prNumber) => { const { number } = currentIssuePr(issue); return number !== undefined && number !== prNumber; };

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
function waitReasons(body) {
  const blocked = [], unknown = [], values = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const strict = /^\s*(?:[-*]\s+)?Wartet bis:(.*)$/i.exec(line);
    // Nur ASCII-Trenner weg: trim() würde ein gültiges Unicode-Leerzeichen am Tagnamen entfernen.
    if (strict) values.push(strict[1].replace(/^[ \t]+|[ \t]+$/g, ''));
    // Formatierte Varianten (**Wartet bis:**, > …, 1. …, - [ ] …) sind keine lesbare Bedingung, aber auch kein Freibrief.
    else if (/^[\s>*_+\-[\]xX\d.#|`~=()]*wartet\s+bis\b/i.test(line)) unknown.push(`unreadable line "${line.trim()}": write it as "Wartet bis: <tag or UTC time>"`);
  }
  for (const wanted of values) {
    // Zurückgestellt bis zu einer Entscheidung: offen, solange die Zeile steht; wer entscheidet, entfernt sie (#514).
    if (/^Entscheidung[ \t]+\S/.test(wanted)) blocked.push(`${decisionWait} ${wanted.replace(/^Entscheidung[ \t]+/, '')} (remove the line "Wartet bis: ${wanted}" once decided)`);
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(wanted)) {
      const at = Date.parse(wanted);
      // Ein Datum wie 2026-02-30 rollt über; nur der unveränderte Wert zählt.
      if (!Number.isFinite(at) || `${new Date(at).toISOString().slice(0, 16)}Z` !== wanted) unknown.push(`invalid "Wartet bis: ${wanted}": no such UTC time`);
      else if (Date.now() < at) blocked.push(`waits until ${wanted} (UTC)`);
    } else if (validTagName(wanted)) {
      try {
        // matching-refs liefert Präfix-Treffer (v0.1.1 findet v0.1.10); nur der genaue Tag zählt.
        const tags = rest(`repos/${project.repository}/git/matching-refs/tags/${wanted.split('/').map(encodeURIComponent).join('/')}`);
        if (!tags.some(tag => tag.ref === `refs/tags/${wanted}`)) blocked.push(`waits for tag ${wanted} (not found)`);
      } catch (error) {
        unknown.push(`cannot read tag ${wanted}: ${String(error.stderr || error.message).trim()}`);
      }
    } else unknown.push(`invalid "Wartet bis: ${wanted}": use a tag name or a UTC time such as 2026-10-12T18:51Z`);
  }
  return { blocked, unknown };
}

// The Draft PR that `start` opens is the claim: its body carries "Agent: claude|codex, Session: ID". The field may stand anywhere in a line
// (Codex wrote it at the end of a sentence), not quoted in code, and "Agent: codex" alone is the claim of an unknown session: it can never be
// the caller's, so it holds the issue until the line in the PR body is edited to the new session (a handover).
const claimField = /(?<![\w`])Agent:[ \t]*(claude|codex)(?![\w-])(?:[ \t]*,[ \t]*Session:[ \t]*(\w[\w.-]*)(?![\w.-]))?/i;
const claimOf = pr => claimField.exec(pr.body ?? '');
// ponytail: sessions are told apart by the id the driver passes, not authenticated; Claude and Codex share one login.
/** The open PR of the issue whose claim names SESSION. */
const ownPr = (issue, session) => session ? openPrs(issue).find(pr => claimOf(pr)?.[2] === session) : undefined;

/**
 * Work of someone on the issue: an open PR that closes it (a Draft too) or a branch `<agent>/<number>-…`. Only the claim of the
 * caller's own session on a PR lifts it, so a driver cannot start in parallel to an agent whose PR names another session or none.
 */
function workReasons(issue, session, takeover) {
  const own = session ? `no claim of session ${session}` : 'pass --session ID to prove it is yours';
  const prs = openPrs(issue);
  // An abandoned PR (see isStale) may be taken over with --session, a fresh one only on purpose with start --takeover (#548): start writes the session into its body.
  const mayTake = session && prs.length && (takeover || isStale(issue));
  const heads = new Set(prs.map(pr => pr.headRefName));
  const describe = pr => `open PR ${refOf(pr.repository, pr.number)}${pr.headRefName ? ` (branch ${pr.headRefName}${claimOf(pr) ? `, ${claimOf(pr)[0]}` : ''})` : ''}`;
  const blocked = mayTake ? [] : prs.map(pr => `${describe(pr)} closes this issue; ${own}`);
  const why = isStale(issue) ? `stale %: no activity for ${ago(idleMs(issue))}` : '%: --takeover';
  const notes = mayTake ? prs.map(pr => `${why.replace('%', describe(pr))}; start takes it over`) : [];
  // A branch without an open PR (#504): without own commits it holds nothing, without a commit for staleHours it is orphaned (a note), else it holds.
  for (const branch of workBranches(issue).filter(branch => !heads.has(branch))) {
    const { ahead, idle } = branchWork(issue, branch), agent = branch.split('/')[0];
    if (!ahead) continue;
    if (idle !== undefined && isStale(issue, idle)) notes.push(`orphaned branch ${branch} (agent ${agent}): no open PR, no commit for ${ago(idle)}; continue on it or branch anew`);
    else blocked.push(`branch ${branch} (agent ${agent}${idle === undefined ? '' : `, last commit ${ago(idle)} ago`}) belongs to this issue; ${own}`);
  }
  return { blocked, notes };
}

let defaultBranch;
/**
 * Own commits of a branch against the issue's base and the age of its newest commit: one REST compare. The commits come oldest first, one page of 100:
 * with more, `idle` is undefined (that many commits are active work). A compare that fails (no base) is an error of the caller: `check` is UNKNOWN, `next` holds that issue.
 * ponytail: one compare per found branch, also per Ready issue in `next`, uncached; cache by branch if `next` gets slow.
 * ponytail: over 100 commits the age is unknown and the branch holds; read the last page of the compare if that bites.
 */
function branchWork(issue, branch) {
  const ref = name => name.split('/').map(encodeURIComponent).join('/');
  const base = baseOf(issue).branch || (defaultBranch ??= rest(`repos/${project.repository}`).default_branch);
  const { ahead_by: ahead, commits = [] } = rest(`repos/${project.repository}/compare/${ref(base)}...${ref(branch)}?per_page=100`);
  assert.ok(Number.isSafeInteger(ahead), `The comparison of ${branch} with ${base} is unreadable`);
  const newest = ahead && commits.length === ahead ? Date.parse(commits.at(-1).commit.committer.date) : NaN;
  return { ahead, idle: Number.isFinite(newest) ? Date.now() - newest : undefined };
}

/** Logins on the issue other than the caller: their claim may predate any PR (#572). */
const foreignAssignees = issue => issue.assignees.nodes.map(user => user.login).filter(login => !sameLogin(login, issue.viewer.login));

/** What the open PRs, branches and assignees of an issue hold against a start by SESSION: one rule for `check` and `next`. */
function startReasons(issue, session, takeover) {
  if (session && claimOf(openPr(issue) ?? {})?.[2] === session) return { blocked: [], notes: [] };
  const found = workReasons(issue, session, takeover), others = foreignAssignees(issue);
  if (others.length && !takeover) found.blocked.push(`assigned to ${others.join(', ')}; pass --takeover to take it over`);
  return found;
}

/** Unfinished work of the caller: rows (number, assignees, projectItems, closedByPullRequestsReferences) in In progress or Automated review that are assigned to the login and whose open PR names SESSION. */
function ownWork(rows, login, session) {
  return rows.filter(row => ['In progress', 'Automated review'].includes(projectStatus(row))
    && row.assignees.nodes.some(assignee => assignee.login.toLowerCase() === login.toLowerCase()) && ownPr(row, session));
}

// Feedback after a handoff (#554): issue comments ride along with the searches; PR feedback is read by actual ids,
// so two connections per PR do not multiply every search slot by ten hypothetical PRs.
const feedbackNode = 'createdAt url body';
const issueFeedback = `comments(last:10){nodes{${feedbackNode}}}`;
const prFeedback = `comments(last:5){nodes{${feedbackNode}}} reviews(last:5){nodes{${feedbackNode}}}`;
const handoffHeading = /^## Übergabe\s*$/m, replyLine = /^Agent:[ \t]*(claude|codex)\b/im;

function loadPrFeedback(issues) {
  const linked = issues.flatMap(issue => issue.closedByPullRequestsReferences?.nodes ?? []);
  assert.ok(linked.every(pr => typeof pr?.id === 'string' && pr.id), 'PR feedback ids are unreadable');
  assert.ok(linked.every(pr => ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)), 'PR feedback states are unreadable');
  const prs = linked.filter(pr => pr.state === 'OPEN');
  const ids = [...new Set(prs.map(pr => pr.id))];
  const feedback = new Map();
  for (let from = 0; from < ids.length; from += 100) {
    const batch = ids.slice(from, from + 100);
    const { nodes } = graphql(`query{nodes(ids:${JSON.stringify(batch)}){...on PullRequest{id ${prFeedback}}}}`);
    assert.ok(nodes?.length === batch.length && nodes.every((pr, index) => pr?.id === batch[index]
      && Array.isArray(pr.comments?.nodes) && Array.isArray(pr.reviews?.nodes)), 'PR feedback is unreadable; retry the read');
    for (const current of nodes) feedback.set(current.id, current);
  }
  for (const pr of prs) Object.assign(pr, feedback.get(pr.id));
}

/**
 * What happened on a ticket since the agent's last word, or undefined. The agent's word is the "## Übergabe" handoff or a comment with an "Agent: claude|codex" line,
 * never the login: agents and humans share it. Counts for an issue assigned to the login (and, with SESSION, claimed by it): everything after that word, and the issue
 * back in In progress or Automated review after the handoff. Any issue: an @mention of the login after it.
 * ponytail: reads the last 10 issue comments, 5 PR comments and 5 reviews, and any agent's marker answers; replace when feedback is missed or a second agent shares a ticket.
 */
function feedback(issue, login, session) {
  const mine = issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === login.toLowerCase()) && (!session || ownPr(issue, session));
  const events = [...(issue.comments?.nodes ?? []), ...openPrs(issue).flatMap(pr => [...(pr.comments?.nodes ?? []), ...(pr.reviews?.nodes ?? [])])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const anchor = events.findLastIndex(event => handoffHeading.test(event.body) || replyLine.test(event.body));
  const mention = new RegExp(`(?<![\\w-])@${RegExp.escape(login)}(?![\\w-])`, 'i'), status = projectStatus(issue), tracked = mine && anchor >= 0;
  const seen = events.slice(anchor + 1).filter(event => tracked || mention.test(event.body));
  const why = [tracked && handoffHeading.test(events[anchor].body) && ['In progress', 'Automated review'].includes(status) && `back in ${status} after the handoff`,
    seen.length && (tracked ? `${seen.length} new comment(s) or review(s) since your last reply or handoff` : `mentions @${login}`)].filter(Boolean);
  return why.length ? { reason: why.join('; '), url: (seen.at(-1) ?? events[anchor]).url } : undefined;
}

/** The open issues assigned to the login, for `check` (one paged search); `next` already holds all open issues. */
function assignedIssues(login) {
  const rows = [];
  for (let after; ;) {
    const { search } = graphql(`query($q:String!,$after:String){search(query:$q,type:ISSUE_ADVANCED,first:30,after:$after){
      issueCount pageInfo{hasNextPage endCursor} nodes{...on Issue{number title assignees(first:10){nodes{login}} ${issueFeedback}
      closedByPullRequestsReferences(first:10){nodes{state body id}}
      projectItems(first:100){nodes{project{id} status:fieldValueByName(name:"Status"){...on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}`,
    { q: `repo:${project.repository} is:issue is:open assignee:${login}`, ...(after && { after }) });
    rows.push(...search.nodes);
    if (!search.pageInfo.hasNextPage) {
      assert.ok(rows.length >= search.issueCount, `Search returned ${rows.length} of ${search.issueCount} issues of ${login}; the own work would be incomplete`);
      loadPrFeedback(rows);
      return rows;
    }
    assert.ok(search.pageInfo.endCursor && search.pageInfo.endCursor !== after, 'Search pagination did not advance');
    after = search.pageInfo.endCursor;
  }
}

/** Base PR of the issue the last check() judged STACKABLE; handoff compares it with the PR's base branch. */
let stackedOn;

/** True when open predecessors are the only thing holding the issue: a stack may then replace the wait. */
const heldOnlyByOpenPredecessors = (reasons, predecessors) => predecessors.open.length > 0 && reasons.length === predecessors.open.length;

/** STARTABLE and STACKABLE both allow work; check() reports the latter with exit 4, which a successful guarded command must not keep. */
function mayStart(verdict) {
  if (!['STARTABLE', 'STACKABLE'].includes(verdict)) return false;
  process.exitCode = 0;
  return true;
}

/** Verdict inputs of one issue, shared by the issue itself and its sub-issues. */
function issueReasons(issue) {
  const status = projectStatus(issue);
  const blocked = [], unknown = [];
  if (issue.state !== 'OPEN') blocked.push('issue is closed');
  if (!projectItem(issue)) unknown.push(`issue is not on ${project.url}`);
  else if (!status) unknown.push('the Project status is unset');
  else if (['Backlog', 'Done'].includes(status)) blocked.push(`status is ${status}`);
  else if (!['Ready', 'In progress', 'Automated review', 'Human review'].includes(status)) unknown.push(`unknown status ${status}`);
  const predecessors = predecessorReasons(issue.blockedBy);
  blocked.push(...predecessors.blocked);
  unknown.push(...predecessors.unknown);
  const waits = waitReasons(issue.body);
  blocked.push(...waits.blocked);
  unknown.push(...waits.unknown);
  return { status, blocked, unknown, predecessors };
}
const verdictOf = ({ blocked, unknown }) => blocked.length ? 'BLOCKED' : unknown.length ? 'UNKNOWN' : 'STARTABLE';
// #N in the project's repository, OWNER/REPO#N elsewhere: a bare number must never name a same-number issue or PR of another repository.
const refOf = (repository, number) => `${repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase() ? '' : repository.nameWithOwner}#${number}`;
const logins = issue => issue.assignees.nodes.map(assignee => assignee.login).join(', ');
/** Who works on an open predecessor and where its PRs stand, from what loadDeliveries read; a list cut at 10 is never presented as complete. */
function predecessorLine(predecessor) {
  const { totalCount, nodes } = predecessor.closedByPullRequestsReferences;
  const prs = nodes.filter(Boolean).map(pr => `${refOf(pr.repository, pr.number)} ${pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase()}`);
  const cut = totalCount > nodes.length ? ` (first ${nodes.length} of ${totalCount})` : '';
  return `predecessor ${refOf(predecessor.repository, predecessor.number)}: assignees: ${predecessor.assignees ? logins(predecessor) || 'none' : 'unreadable'}; PRs: ${prs.join(', ') || 'none'}${cut}`;
}
const ago = ms => {
  const minutes = Math.max(0, Math.floor(ms / 60_000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

/** The base branch the Project field names for the issue (empty without a setting or a value). */
function baseOf(issue) {
  const setting = baseSetting(), found = projectItem(issue)?.base, value = (found?.name ?? found?.text ?? '').trim();
  return { setting, value, branch: setting && value && (Object.hasOwn(setting.values ?? {}, value) ? setting.values[value] : setting.pattern.replace('{value}', () => value)) };
}

/** The base the Project field names and whether HEAD stands on it; local git only, no fetch. Information only, never a verdict. */
function baseLines(issue, stacked) {
  const { setting, value, branch } = baseOf(issue);
  if (!setting) return [];
  if (!value) return [`note: the Project field ${setting.field} is empty; no base branch to name`];
  const remote = `origin/${branch}`;
  const git = externalTool('git', process.cwd(), projectDirectory);
  // Git's exit code: 0 yes, 1 the expected "no", anything else is git failing (no checkout, no git) and says nothing about the base.
  const exit = (...args) => { try { execFileSync(git.file, ['-C', projectDirectory, ...args], { env: git.env, stdio: 'ignore' }); return 0; } catch (error) { return error.status ?? -1; } };
  const lines = [`base: ${branch} (${setting.field})`];
  let code = exit('check-ref-format', `refs/heads/${branch}`); // --branch would die with 128 instead of 1
  if (code === 1) return [...lines, `note: ${branch} is not a valid branch name; fix the value of ${setting.field}`];
  if (code === 0) code = exit('rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`);
  if (code === 1) return [...lines, `note: ${remote} is not known in this checkout; run git fetch origin`];
  // A stack starts from its base PR's branch, and an issue that has a branch was started: HEAD is not the base's business then.
  if (code === 0 && !stacked && !(issue.branches ?? []).some(ref => new RegExp(`^[\\w.-]+/${issue.number}-`).test(ref.name))) code = exit('merge-base', '--is-ancestor', `refs/remotes/${remote}`, 'HEAD');
  if (code === 1) lines.push(`note: HEAD is not on ${remote}; create the branch from there (git fetch origin, then git switch -c <branch> ${remote})`);
  else if (code) lines.push(`note: git could not check ${remote} (exit ${code}); no advice on the base`);
  return lines;
}

/** Without `claims` (status transitions) only the verdict prints; the `check` command adds the open PRs with their claims and sub-issues. Information only. */
function check(issue = readIssue(), claims, currentPrNumber) {
  let current = currentIssuePr(issue);
  if (currentPrNumber !== undefined && !current.unknown && current.number !== currentPrNumber) {
    current = current.number === undefined ? { unknown: `PR #${currentPrNumber} is not the unique open local PR linked to this issue` } : { partial: true };
  }
  const { status, blocked, unknown, predecessors } = issueReasons(issue);
  const notes = [];
  if (claims) try {
    const found = startReasons(issue, claims.session, claims.takeover);
    blocked.push(...found.blocked);
    notes.push(...found.notes);
  } catch (error) { unknown.push(`branches are unreadable: ${String(error.stderr || error.message).trim()}`); }
  // Only open predecessors hold the issue (no other blocker, not even foreign work or a status): look for the PR to stack on.
  stackedOn = undefined;
  const heldOnlyByOpen = heldOnlyByOpenPredecessors(blocked, predecessors);
  if (current?.unknown && (currentPrNumber !== undefined || heldOnlyByOpen)) {
    unknown.push(current.unknown);
    if (heldOnlyByOpen) blocked.length = 0;
  }
  if (heldOnlyByOpen && !unknown.length) {
    const stack = stackBase(predecessors.open, current?.number);
    if (stack.pr) {
      stackedOn = stack.pr;
      notes.push(...blocked.map(reason => `${reason}; delivered by PR #${stack.pr.number}`));
      blocked.length = 0;
    } else if (stack.unknown.length && !stack.refused.length) {
      unknown.push(...stack.unknown);
      blocked.length = 0;
    // A definitive refusal stays BLOCKED, whatever else is unreadable: a retry cannot lift it.
    } else notes.push(...stack.refused.map(reason => `not stackable: ${reason}`), ...stack.unknown.map(reason => `unreadable: ${reason}`));
  }
  // Finish first: another issue of the caller in In progress or Automated review holds a new start (not a resume, not a stack on that very work).
  if (claims?.session && !blocked.length && !unknown.length && !ownPr(issue, claims.session)) try {
    const login = issue.viewer.login, rows = assignedIssues(login), work = ownWork(rows, login, claims.session);
    // Feedback on a handed-off issue of the own session comes before new work too (#554).
    const mine = work.map(own => [own, `it is your open work (${projectItem(own).status.name}); hand it off before starting another issue`]);
    for (const row of rows.filter(row => !work.includes(row) && ownPr(row, claims.session))) {
      const found = feedback(row, login, claims.session);
      if (found) mine.push([row, `it has feedback (${found.reason}, ${found.url}); answer it in the ticket or hand it off again before starting another issue`]);
    }
    // Own work that is the base of the stack is continued, not left behind; any other own issue still comes first.
    const base = own => stackedOn && predecessors.open.some(open => open.number === own.number && open.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase());
    blocked.push(...mine.filter(([own]) => own.number !== issue.number && !base(own)).map(([own, why]) => `finish #${own.number} first: ${why}`));
  } catch (error) { unknown.push(`own open work is unreadable: ${String(error.stderr || error.message).trim()}`); }
  const plain = verdictOf({ blocked, unknown });
  const verdict = stackedOn && plain === 'STARTABLE' ? 'STACKABLE' : plain;
  console.log(`${project.repository}#${issue.number} ${issue.title}\nstatus: ${status ?? '-'}, assignees: ${logins(issue) || 'none'}\n${verdict}`);
  for (const reason of [...blocked, ...unknown]) console.log(`- ${reason}`);
  // Only where loadDeliveries ran (open predecessors alone hold the issue) the PRs are known; elsewhere nothing is claimed.
  for (const predecessor of predecessors.open) if (predecessor.closedByPullRequestsReferences?.nodes) console.log(predecessorLine(predecessor));
  if (stackedOn) console.log(stackedOn.state === 'MERGED'
    ? `stack base: PR #${stackedOn.number} is already merged into ${stackedOn.baseRefName}: no stack, work on ${stackedOn.baseRefName}; see docs/CONTRIBUTING.md#stacked-pull-requests`
    : `stack base: PR #${stackedOn.number}${stackedOn.stackNumber ? ` in stack #${stackedOn.stackNumber}` : ''} (branch ${stackedOn.headRefName}, base ${stackedOn.baseRefName}); see docs/CONTRIBUTING.md#stacked-pull-requests`);
  for (const note of notes) console.log(`note: ${note}`);
  if (claims) for (const line of baseLines(issue, stackedOn)) console.log(line);
  if (claims) {
    const linked = issue.closedByPullRequestsReferences;
    const prs = openPrs(issue).map(pr => `${refOf(pr.repository, pr.number)} (Session ${claimOf(pr)?.[2] ?? 'unknown'})`);
    // A list cut at 100 is never presented as complete.
    const cut = linked?.totalCount > linked?.nodes?.length ? ` (first ${linked.nodes.length} of ${linked.totalCount})` : '';
    if (prs.length) console.log(`open PR: ${prs.join(', ')}${cut}`);
  }
  if (claims && issue.subIssues?.nodes?.length) {
    if (issue.subIssues.totalCount > issue.subIssues.nodes.length) console.log(`note: ${issue.subIssues.nodes.length} of ${issue.subIssues.totalCount} sub-issues listed`);
    for (const child of issue.subIssues.nodes) {
      console.log(`${refOf(child.repository, child.number)}  ${projectItem(child)?.status?.name ?? '-'}  ${logins(child) || '-'}  ${verdictOf(issueReasons(child))}`);
    }
  }
  // STACKABLE is not 0: a caller that knows only STARTABLE must not start it without the stack rules.
  process.exitCode = { STARTABLE: 0, BLOCKED: 1, UNKNOWN: 2, STACKABLE: 4 }[verdict];
  return verdict;
}

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
          body: `Geliefert mit #${delivered.number} in \`${delivered.baseRefName}\`. Der Release-PR nach \`main\` veröffentlicht die Version.` });
        graphql('mutation($issue:ID!){closeIssue(input:{issueId:$issue,stateReason:COMPLETED}){clientMutationId}}', { issue: issue.id });
        console.log(`#${issue.number} closed: delivered with PR #${delivered.number} in ${delivered.baseRefName}`);
        resets++;
        continue;
      }
      if (projectItem(issue)?.status?.name !== 'Human review') continue;
      assert.ok(linked.totalCount <= linked.nodes.length, `#${issue.number} has more linked PRs than sweep reads; it would be reported clean`);
      const pr = own.find(node => node.state === 'OPEN' && node.mergeStateStatus === 'DIRTY');
      if (!pr) continue;
      plan ??= resolveOption('Status', 'Automated review');
      // The comment first: a failed comment must not leave an issue out of Human review that nobody was told about.
      graphql('mutation($issue:ID!,$body:String!){addComment(input:{subjectId:$issue,body:$body}){clientMutationId}}', { issue: issue.id,
        body: `Der PR ${pr.url} hat Konflikte mit seiner Basis, ein Issue in Human review muss aber mergebar sein. Das Issue geht zurück auf Automated review. Konflikt lösen, dann neu übergeben (\`board.mjs done\`).` });
      writeOption(issue, plan);
      console.log(`#${issue.number} reset to Automated review: PR #${pr.number} has merge conflicts`);
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
  const rank = selectField('Priority').choices.map(choice => choice.name);
  const order = priority => rank.includes(priority) ? rank.indexOf(priority) : rank.length;
  const ready = nodes.map(issue => ({ ...issue, item: projectItem(issue) }))
    .filter(issue => issue.item?.status?.name === 'Ready')
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
  const abandoned = nodes.filter(issue => ['In progress', 'Automated review', 'Human review'].includes(status(issue)) && !mine.includes(issue) && openPr(issue) && isStale(issue));
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

/** A single-select Project field with its options in configured order. The definitions are read once per run, however many fields are looked up. */
let projectFields;
function selectField(fieldName) {
  projectFields ??= graphql(`query($id:ID!){node(id:$id){...on ProjectV2{fields(first:100){nodes{...on ProjectV2SingleSelectField{
    id name options{id name} issueField{...on IssueFieldSingleSelect{id options{id name}}}}}}}}}`, { id: project.id })
    .node.fields.nodes.filter(candidate => candidate.name && candidate.options);
  const fields = projectFields;
  const field = fields.find(candidate => candidate.name === fieldName);
  assert.ok(field, `${project.url} has no single-select ${fieldName} field; use one of: ${fields.map(candidate => candidate.name).join(', ')}`);
  // An empty Project option list means the field mirrors an organization issue field.
  const linked = !field.options.length && field.issueField;
  return { field, linked, choices: linked ? linked.options : field.options };
}

/**
 * Put the issue on the Project. A new issue may already have been added by the Project's own automation: GitHub then
 * refuses with "already exists", which is no failure as long as the item can be read afterwards.
 */
function addToProject(issue) {
  try {
    return graphql(`mutation($project:ID!,$content:ID!){addProjectV2ItemById(
      input:{projectId:$project,contentId:$content}){item{id}}}`, { project: project.id, content: issue.id }).addProjectV2ItemById.item.id;
  } catch (error) {
    if (!/already exists in this project/i.test(String(error.stderr ?? ''))) throw error;
    const id = projectItem(readIssue())?.id;
    assert.ok(id, `GitHub reports #${issue.number} as already on the Project, but its item is unreadable`);
    return id;
  }
}

/** Look up a field and option; nothing is printed or written. */
function resolveOption(fieldName, optionName) {
  const { field, linked, choices } = selectField(fieldName);
  const normalized = name => String(fieldName === 'Status' ? statusName(name) : name).toLowerCase();
  const option = choices.find(choice => choice.name.toLowerCase() === String(optionName).toLowerCase())
    ?? choices.find(choice => normalized(choice.name) === normalized(optionName));
  assert.ok(option, `${fieldName}: "${optionName}" is not an option; use one of: ${choices.map(choice => choice.name).join(', ')}`);
  return { fieldName, field, linked, option };
}

/** Guards of a transition; a refusal throws. They print (backlinks), so run them only after every pair is valid. */
function guardOption(issue, { fieldName, option }) {
  guardSpecStatus(issue, { fieldName, option });
  if (fieldName === 'Status' && option.name === 'Ready') {
    // Ready contradicts an open decision wait: it stays Backlog until the line is removed (#514).
    const decisions = waitReasons(issue.body).blocked.filter(reason => reason.startsWith(decisionWait));
    if (decisions.length) throw new Error(`#${issue.number} cannot be Ready: ${decisions.join('; ')}`);
  }
  if (fieldName === 'Status' && option.name === 'In progress') {
    // Assignment first, so a missing assignment is named even when the issue is also blocked.
    const { viewer } = graphql('query{viewer{login}}');
    assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
    assert.ok(issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase()),
      `Assign yourself first: gh issue edit ${number} --repo ${project.repository} --add-assignee "@me". Verify session ownership before assigning.`);
    // A refusal is an error like the others: its verdict lines become the one ERROR line instead of a second output format.
    const log = console.log, verdict = [];
    // An open issue in Done was reopened by a human (a merge closes it): it may leave Done, with a note (#510). A closed one stays blocked.
    const wasDone = issue.state === 'OPEN' && projectItem(issue)?.status?.name === 'Done';
    const judged = wasDone ? { ...issue, projectItems: { nodes: issue.projectItems.nodes.map(item => item === projectItem(issue) ? { ...item, status: { name: 'Ready' } } : item) } } : issue;
    console.log = (...parts) => verdict.push(parts.join(' '));
    try { if (!mayStart(check(judged))) throw new Error(verdict.join('; ')); } finally { console.log = log; }
    if (wasDone) log(`note: #${issue.number} is open again and was Done; it moves to In progress`);
  }
  if (fieldName === 'Status' && statusName(option.name) === 'Automated review') verifyBacklinks(issue);
}

function writeOption(issue, { fieldName, field, linked, option }) {
  const beforeSend = () => guardSpecStatus(issue, { fieldName, option });
  if (linked) {
    graphql(`mutation($issue:ID!,$field:ID!,$option:ID!){setIssueFieldValue(input:{issueId:$issue,
      issueFields:[{fieldId:$field,singleSelectOptionId:$option}]}){clientMutationId}}`,
    { issue: issue.id, field: linked.id, option: option.id }, undefined, beforeSend);
  } else {
    let item = projectItem(issue)?.id;
    if (!item) {
      item = addToProject(issue);
      // Later writes of the same call reuse the item instead of adding it again.
      issue.projectItems.nodes.push({ id: item, project: { id: project.id } });
    }
    graphql(`mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,
      itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
    { project: project.id, item, field: field.id, option: option.id }, undefined, beforeSend);
  }
  return `${project.repository}#${issue.number} ${fieldName}: ${option.name}`;
}

/** Write a selected field option; guarded delivery can reject the fresh issue before mutation. */
function set(fieldName, optionName = value, beforeWrite) {
  let issue = readIssue();
  const plan = resolveOption(fieldName, optionName);
  guardOption(issue, plan);
  // A guarded handoff rechecks current ownership/readiness after the potentially lengthy review reads.
  if (beforeWrite) {
    issue = beforeWrite();
    if (!issue) return;
  }
  console.log(writeOption(issue, plan));
  return plan.option.name;
}

/** NAME VALUE pairs after the issue; `Status "Automated review" PR [OTHER_ISSUE...]` keeps its own trailing arguments. */
function fieldPairs() {
  const args = process.argv.slice(4).filter(arg => arg !== '--spec-review');
  if (args[0].toLowerCase() === 'status' && statusName(args[1]).toLowerCase() === 'automated review') return [args.slice(0, 2)];
  assert.ok(args.length % 2 === 0, 'field takes NAME VALUE pairs: field ISSUE NAME VALUE [NAME VALUE ...]');
  const pairs = Array.from({ length: args.length / 2 }, (_, index) => args.slice(index * 2, index * 2 + 2));
  return pairs;
}

/** Resolve NAME VALUE pairs against the Project's fields; nothing is written. */
function planFields(pairs) {
  assert.equal(new Set(pairs.map(([fieldName]) => fieldName.toLowerCase())).size, pairs.length, 'Each field may appear once per call');
  return pairs.map(([fieldName, optionName]) => resolveOption(fieldName, optionName));
}

/** Any single-select fields: every pair is validated before the first write, then all are read back together so a silent API no-op cannot pass. */
function setField() {
  const issue = readIssue();
  console.log(applyFields(issue, planFields(fieldPairs())).join('\n'));
}

/** Write resolved plans on the issue and read them all back; returns one confirmation line per plan. */
function applyFields(issue, plans) {
  for (const plan of plans) guardOption(issue, plan);
  // Confirmation lines come after the read-back, so a failed call never shows a write as confirmed.
  const written = plans.map(plan => writeOption(issue, plan));
  const { repository } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    issue(number:$number){projectItems(first:100){nodes{project{id} fieldValues(first:100){nodes{
      ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}}}}}
    issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}}`,
  { owner, name, number });
  const values = [...projectItem(repository.issue)?.fieldValues.nodes ?? [], ...repository.issue.issueFieldValues.nodes];
  for (const { fieldName, option } of plans) {
    const stored = values.find(entry => entry?.field?.name === fieldName)?.name;
    assert.equal(stored, option.name, `Read-back of ${fieldName} shows ${stored ?? 'no value'}`);
  }
  return written;
}

/** Flags of `new`; unknown or repeated single flags are errors, never ignored. */
function newOptions(args) {
  const given = {}, single = ['--title', '--body-file', '--milestone', '--priority', '--status'];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    assert.ok([...single, '--label', '--field'].includes(flag), `new: unknown option ${flag}`);
    const text = args[++index];
    assert.ok(text !== undefined && !text.startsWith('--'), `new: ${flag} needs a value`);
    (given[flag] ??= []).push(text);
  }
  for (const flag of single) assert.ok((given[flag]?.length ?? 0) <= 1, `new: ${flag} may appear once`);
  const [title, bodyFile, milestone, priority, status] = single.map(flag => given[flag]?.[0]);
  const fields = (given['--field'] ?? []).map(pair => {
    const split = pair.indexOf('=');
    assert.ok(split > 0 && split < pair.length - 1, `new: --field wants NAME=VALUE, got "${pair}"`);
    return [pair.slice(0, split), pair.slice(split + 1)];
  });
  return { title, bodyFile, milestone, priority, status, fields, labels: given['--label'] ?? [] };
}

/**
 * One issue to create, every value checked and resolved before anything exists: body, Project fields (all of them against one read
 * of the field definitions), milestone and labels. `status` is the Status the command sets.
 */
let repositoryLists;
const sameTitle = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function planNew({ title, bodyFile, milestone, priority, labels: wanted, fields }, status = 'Backlog') {
  for (const [what, text] of [['title', title], ['body file', bodyFile], ['milestone', milestone], ['priority', priority]]) assert.ok(text, `${what} is required`);
  assert.ok(wanted.length, 'at least one label is required');
  const text = readFileSync(bodyFile, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  assert.ok(text, `${bodyFile} is empty`);
  assert.ok(!fields.some(([fieldName]) => ['status', 'priority'].includes(fieldName.toLowerCase())), 'Status and Priority are not field values (give the priority; the command sets Status)');
  const pairs = [['Status', status], ['Priority', priority], ...fields];
  for (const required of project.requiredFields ?? []) {
    assert.ok(pairs.some(([fieldName]) => fieldName.toLowerCase() === required.toLowerCase()), `the project requires ${required}: give a value for it`);
  }
  const plans = planFields(pairs);
  assert.ok(!wanted.some(label => label.toLowerCase() === specLabel.toLowerCase()) || plans.find(plan => plan.fieldName === 'Status').option.name === 'Backlog', 'A new spec starts in Backlog; only a human-invoked spec-review changes its status');
  // Open issues over REST, not the search index, which misses one created seconds ago by a parallel session (#618). PRs are listed too.
  repositoryLists ??= { milestones: restAll(`repos/${project.repository}/milestones`), labels: restAll(`repos/${project.repository}/labels`),
    issues: restAll(`repos/${project.repository}/issues`).filter(item => !item.pull_request) };
  // shortcut: two sessions creating within the same second still both pass; GitHub has no conditional create.
  const same = repositoryLists.issues.find(item => sameTitle(item.title, title));
  assert.ok(!same, `open issue ${same?.html_url} already has the title "${title}"; link it (board.mjs sub PARENT ${same?.number}) instead of creating it again`);
  const exact = (list, name, key) => list.find(item => item[key].toLowerCase() === name.toLowerCase());
  const found = exact(repositoryLists.milestones, milestone, 'title');
  assert.ok(found, `${project.repository} has no open milestone "${milestone}"`);
  // The REST API would silently create an unknown label.
  // A repeated label (any casing) is one label: GitHub stores it once, and the read-back compares exactly.
  const labels = [...new Set(wanted.map(label => exact(repositoryLists.labels, label, 'name')?.name ?? assert.fail(`${project.repository} has no label "${label}"`)))];
  return { title, text, plans, milestone: found, labels };
}

/** The REST call that creates the issue (no GraphQL point). A lost or unreadable answer does not prove that nothing was created. */
function post({ title, text, milestone, labels }) {
  try {
    const created = JSON.parse(execFileSync(gh.file, ['api', `repos/${project.repository}/issues`, '-X', 'POST', '--input', '-'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: JSON.stringify({ title, body: text, milestone: milestone.number, labels }) }));
    assert.ok(Number.isSafeInteger(created?.number) && created.html_url && created.node_id, 'GitHub did not report the new issue');
    return created;
  } catch (error) {
    throw new Error(`creating the issue failed (${String(error.stderr || error.message).trim()}); it may exist anyway: search ${project.repository} for "${title}" before trying again`, { cause: error });
  }
}

/** The milestone and labels GitHub stored. */
function readBackIssue(created, { milestone, labels }) {
  const stored = rest(`repos/${project.repository}/issues/${created.number}`);
  assert.equal(stored.milestone?.title, milestone.title, `Read-back of the milestone shows ${stored.milestone?.title ?? 'none'}`);
  assert.deepEqual(stored.labels.map(label => label.name).sort(), [...labels].sort(), 'Read-back of the labels differs');
}

/** The one-line result of `new`. Later plans replace earlier ones of the same field (Status: Ready, then In progress). */
const newLine = (created, { milestone, labels, plans }, ...more) => [`NEW ${created.html_url}`, `milestone: ${milestone.title}`, `labels: ${labels.join(', ')}`,
  ...Object.entries(Object.fromEntries(plans.map(plan => [plan.fieldName, plan.option.name]))).map(([fieldName, value]) => `${fieldName}: ${value}`), ...more].join(' | ');

// GitHub cuts a request off after 10 seconds. Measured on 2026-10-07: 50 aliased Project writes took 2 to 3 seconds, 100 took 3 to 4.
// ponytail: 50 stays well inside that and below any size seen to fail; raise it only when a measured batch needs fewer requests.
const mutationsPerRequest = 50;
// GitHub's ids and field options are plain text: a JSON string is a valid GraphQL string.
const quoted = JSON.stringify;

/**
 * Mutations in as many aliased requests as `mutationsPerRequest` needs; the answers are keyed `m0`, `m1`, … in the order of `calls`.
 * `tolerate`: see graphql().
 */
function mutateAll(calls, tolerate) {
  const results = {};
  for (let from = 0; from < calls.length; from += mutationsPerRequest) {
    const chunk = calls.slice(from, from + mutationsPerRequest).map((call, index) => `m${from + index}:${call}`);
    Object.assign(results, graphql(`mutation{${chunk.join(' ')}}`, {}, tolerate));
  }
  return results;
}

// GitHub also refuses a request by its cost ("Resource limits for this query exceeded"): 13 issues in one request failed on 2026-10-07.
// ponytail: 5 issues per request is a guess below that point; a refused block is halved down to one issue, so raise it only when measured.
const issuesPerRequest = 5;
const resourceLimit = /Resource limits for this query exceeded/i;

/** Run `step` on the rows; GitHub's cost limit halves the block and tries each half again, down to one row, which `refused` names. */
function inBlocks(rows, step, refused, size = issuesPerRequest) {
  for (let from = 0; from < rows.length; from += size) shrink(rows.slice(from, from + size), step, refused);
}
function shrink(block, step, refused) {
  try { step(block); } catch (error) {
    if (!resourceLimit.test(`${error.stderr}${error.stdout}`)) throw error;
    if (block.length === 1) return refused(block[0]);
    const half = Math.ceil(block.length / 2);
    shrink(block.slice(0, half), step, refused);
    shrink(block.slice(half), step, refused);
  }
}

/**
 * Put freshly created issues on the Project and write their fields in blocks of `issuesPerRequest` issues: per block one request
 * to add them, one to write every value, one to read every value back. `rows`: { id: issue node id, number, plans }.
 * An issue whose fields are not all written and read back (even alone GitHub refuses it, or a value differs) is not skipped:
 * the failure lists every such issue with the `field` command that finishes it.
 */
function setFields(rows) {
  const todo = new Map(); // row -> [{ plan, why }]
  const miss = (row, plan, why) => todo.set(row, [...todo.get(row) ?? [], { plan, why }]);
  const refuse = (what, row) => row.plans.forEach(plan => miss(row, plan, `GitHub refuses ${what} of #${row.number} even alone ("Resource limits for this query exceeded")`));
  inBlocks(rows, writeBlock, row => refuse('the write', row));
  inBlocks(rows.filter(row => !todo.has(row)), readBlock(miss), row => refuse('the read-back', row));
  const word = text => /^[^\s"]+$/.test(text) ? text : quoted(text);
  assert.ok(!todo.size, [...todo].map(([row, misses]) => `${[...new Set(misses.map(({ why }) => why))].join('; ')}; finish it with: board.mjs field ${row.number} ${
    [...new Map(misses.map(({ plan }) => [plan.fieldName, plan.option.name]))].flat().map(word).join(' ')}`).join(' | '));
}

/** The Project item and the values of one block of rows. */
function writeBlock(rows) {
  const onProject = rows.filter(row => !row.item && row.plans.some(plan => !plan.linked));
  // The Project's own automation may have added an issue already: GitHub then refuses that one with "already exists", which is
  // no failure as long as its item can be read.
  const added = mutateAll(onProject.map(row => `addProjectV2ItemById(input:{projectId:${quoted(project.id)},contentId:${quoted(row.id)}}){item{id}}`),
    /already exists in this project/i);
  onProject.forEach((row, index) => { row.item = added[`m${index}`]?.item.id; });
  const raced = onProject.filter(row => !row.item);
  if (raced.length) {
    const { nodes } = graphql(`query{nodes(ids:${quoted(raced.map(row => row.id))}){...on Issue{projectItems(first:100){nodes{id project{id}}}}}}`);
    raced.forEach((row, index) => {
      row.item = nodes[index]?.projectItems.nodes.find(item => item.project.id === project.id)?.id;
      assert.ok(row.item, `GitHub reports #${row.number} as already on the Project, but its item is unreadable`);
    });
  }
  mutateAll(rows.flatMap(row => row.plans.map(({ field, linked, option }) => linked
    ? `setIssueFieldValue(input:{issueId:${quoted(row.id)},issueFields:[{fieldId:${quoted(linked.id)},singleSelectOptionId:${quoted(option.id)}}]}){clientMutationId}`
    : `updateProjectV2ItemFieldValue(input:{projectId:${quoted(project.id)},itemId:${quoted(row.item)},fieldId:${quoted(field.id)},value:{singleSelectOptionId:${quoted(option.id)}}}){projectV2Item{id}}`)));
}

/** Read one block back by id, so a silent API no-op cannot pass; a value that differs goes to `miss`. The read costs by the number of ids, not by the 100-value limits of an issue's lists. */
const readBlock = miss => rows => {
  const onProject = rows.filter(row => row.plans.some(plan => !plan.linked));
  const onIssue = rows.filter(row => row.plans.some(plan => plan.linked));
  const read = graphql(`query{
    ${onProject.length ? `items:nodes(ids:${quoted(onProject.map(row => row.item))}){...on ProjectV2Item{fieldValues(first:100){nodes{
      ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}}}}}` : ''}
    ${onIssue.length ? `issues:nodes(ids:${quoted(onIssue.map(row => row.id))}){...on Issue{issueFieldValues(first:100){nodes{
      ...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}` : ''}}`);
  for (const row of rows) {
    const values = [...read.items?.[onProject.indexOf(row)]?.fieldValues.nodes ?? [], ...read.issues?.[onIssue.indexOf(row)]?.issueFieldValues.nodes ?? []];
    for (const plan of row.plans) {
      const stored = values.find(entry => entry?.field?.name === plan.fieldName)?.name;
      if (stored !== plan.option.name) miss(row, plan, `Read-back of ${plan.fieldName} on #${row.number} shows ${stored ?? 'no value'}`);
    }
  }
};

/**
 * Create an issue with everything the workflow requires and read every value back. All inputs are checked before the
 * issue exists (Project fields, milestone, labels, start prerequisites); a failure after it names the issue so it is
 * finished by hand, never created twice. `--from FILE` creates a whole list instead (createMany).
 */
function create() {
  const args = process.argv.slice(3);
  if (args[0] === '--from') return createMany(args.slice(1));
  const options = newOptions(args);
  // Status is set by the command: Backlog or --status (checked against the Project options by planFields).
  const plan = named('new', () => planNew(options, options.status ?? 'Backlog'));
  const created = post(plan);
  number = created.number;
  let step = 'reading it back';
  try {
    readBackIssue(created, plan);
    step = 'setting the Project fields';
    setFields([{ id: created.node_id, number, plans: plan.plans }]);
    console.log(newLine(created, plan));
  } catch (error) {
    throw new Error(`${created.html_url} was created, but ${step} failed: ${String(error.stderr || error.message).trim()}; finish by hand with board.mjs field, do not create it again`, { cause: error });
  }
}

// ponytail: 50 issues per file stay far below GitHub's limit for creating content (80 a minute); split a longer list by hand.
const manyLimit = 50;
const entryKeys = ['title', 'bodyFile', 'milestone', 'priority', 'labels', 'fields'];

/**
 * `new --from FILE`: FILE is a JSON list of `{ title, bodyFile, milestone, priority, labels: [..], fields: { NAME: VALUE } }`
 * (the flags of a single `new`; the Status is Backlog). Every entry is checked before the first issue exists, so one bad entry
 * creates nothing. The issues are created over REST, then all of them get their Project fields in blocks of issues
 * (setFields), and one line per issue is printed after everything was read back. Later failures name every issue that exists.
 */
function createMany([file, ...extra]) {
  assert.ok(file && !file.startsWith('--') && !extra.length, 'new --from takes one FILE and no other option');
  const list = named(`new --from: ${file}`, () => JSON.parse(readFileSync(file, 'utf8')));
  assert.ok(Array.isArray(list) && list.length && list.length <= manyLimit, `new --from: ${file} must hold a JSON list of 1 to ${manyLimit} issues`);
  const plans = list.map((entry, index) => named(`new --from: entry ${index + 1}${typeof entry?.title === 'string' ? ` "${entry.title}"` : ''}`, () => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'an entry is an object');
    const unknown = Object.keys(entry).filter(key => !entryKeys.includes(key));
    assert.ok(!unknown.length, `unknown key ${unknown.join(', ')}; the keys are ${entryKeys.join(', ')}`);
    const { labels = [], fields = {} } = entry;
    assert.ok(['title', 'bodyFile', 'milestone', 'priority'].every(key => entry[key] === undefined || typeof entry[key] === 'string'), 'title, bodyFile, milestone and priority are text');
    assert.ok(Array.isArray(labels) && labels.every(label => typeof label === 'string'), 'labels is a list of label names');
    assert.ok(fields && typeof fields === 'object' && !Array.isArray(fields) && Object.values(fields).every(value => typeof value === 'string'), 'fields is an object of NAME: VALUE');
    return planNew({ ...entry, labels, fields: Object.entries(fields) });
  }));
  const twice = plans.find((plan, index) => plans.findIndex(other => sameTitle(other.title, plan.title)) !== index);
  assert.ok(!twice, `new --from: the title "${twice?.title}" appears twice in ${file}`);
  const made = [];
  const known = () => made.length ? `${made.length} of ${plans.length} issues exist: ${made.map(({ created }) => created.html_url).join(' ')}` : 'none was created';
  try {
    for (const plan of plans) made.push({ plan, created: post(plan) });
  } catch (error) {
    throw new Error(`${error.message}; ${known()}; create only the missing ones, never an existing one again`, { cause: error });
  }
  let step = 'reading them back';
  try {
    for (const { created, plan } of made) readBackIssue(created, plan);
    step = 'setting the Project fields';
    setFields(made.map(({ created, plan }) => ({ id: created.node_id, number: created.number, plans: plan.plans })));
    console.log(made.map(({ created, plan }) => newLine(created, plan)).join('\n'));
  } catch (error) {
    throw new Error(`${known()}, but ${step} failed: ${String(error.stderr || error.message).trim()}; finish by hand with board.mjs field/status, do not create them again`, { cause: error });
  }
}

// Reviewers run unreliably, so only traces on the current head count (docs/CONTRIBUTING.md#review-loop).
const prQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  number state isDraft createdAt headRefName headRefOid baseRefName mergeStateStatus reviewDecision isCrossRepository headRepository{nameWithOwner} body${project.selfReview === undefined ? '' : ' bodyHTML'}
  readyEvents:timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  firstReadyEvents:timelineItems(first:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{...on ReadyForReviewEvent{createdAt}}}
  convertEvents:timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{...on ConvertToDraftEvent{createdAt}}}
  latestOpinionatedReviews(first:100){totalCount nodes{state author{login}}}
  reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{url}}}}
  commits(last:1){nodes{commit{oid committedDate checkSuites(first:100){totalCount nodes{createdAt status conclusion app{slug} workflowRun{databaseId workflow{id}} checkRuns(first:1){totalCount}}}
    statusCheckRollup{contexts(first:100){totalCount nodes{__typename
      ...on CheckRun{name status conclusion title summary detailsUrl startedAt completedAt checkSuite{databaseId createdAt app{slug} workflowRun{databaseId event workflow{id name}}}}
      ...on StatusContext{context state description createdAt creator{login}}}}}}}}
  reviewRequests(first:100){totalCount nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{name}}}}
  requestEvents:timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT]){totalCount nodes{...on ReviewRequestedEvent{createdAt
    requestedReviewer{...on User{login} ...on Bot{login} ...on Team{name}}}}}}}}`;
// ponytail: checks, check suites, review requests and opinionated reviews stop at 100 with ERROR, never a wrong verdict; paginate when a project gets there.

/** Links of unresolved review threads across every page, including findings on earlier heads. */
function unresolvedThreads(prNumber = number, firstPage) {
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
const rest = path => JSON.parse(execFileSync(gh.file, ['api', path], { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, stdio: 'pipe' }));
/** Every page, so an early bot summary on a long PR is never cut off. */
function restAll(path, expected) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = rest(`${path}?per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch) && batch.length <= 100, 'Unreadable REST page');
    items.push(...batch);
    assert.ok(expected === undefined || items.length <= expected, 'More comments than declared; retry the read');
    if (batch.length < 100) return items;
  }
}

/** Every comment of an open issue, complete and unique, or an exception: a partial list must never read as "no backlink". */
function issueComments(repository, issueNumber) {
  const issue = rest(`repos/${repository}/issues/${issueNumber}`);
  assert.ok(issue?.number === issueNumber && issue.state === 'open' && !issue.pull_request,
    `#${issueNumber} is not an open issue`);
  assert.ok(Number.isSafeInteger(issue.comments) && issue.comments >= 0, 'Issue comment count is unreadable');
  const comments = restAll(`repos/${repository}/issues/${issueNumber}/comments`, issue.comments);
  assert.equal(comments.length, issue.comments, `Not every comment on #${issueNumber} is readable; retry the read`);
  assert.ok(comments.every(comment => Number.isSafeInteger(comment?.id) && typeof comment.body === 'string'), 'Unreadable issue comment');
  assert.equal(new Set(comments.map(comment => comment.id)).size, comments.length, 'Duplicate comment page');
  return comments;
}

/** The comment that `status ... "Automated review"` accepts: it names the PR's full URL, whatever surrounds it. Shared by that guard and `link`. */
const findBacklink = (comments, prUrl) => comments.find(comment => (comment.body.match(/https?:\/\/[^\s<>()[\]`"']+/g) ?? []).some(link => {
  try {
    const target = new URL(link.replace(/[.,;:!?]+$/, ''));
    return target.origin === prUrl.origin && target.pathname.replace(/\/$/, '') === prUrl.pathname;
  } catch { return false; } // An unrelated malformed URL is not a backlink.
}));

/** Explicit scope works with Refs on release branches; native closing links remain a separate proof. */
let delivered; // [PR, ...OTHER_ISSUE] as `done` knows them; else they follow "Automated review" on the command line
function verifyBacklinks(issue) {
  const [prRef, ...extraIssues] = delivered ?? process.argv.filter(arg => arg !== '--spec-review').slice(command === 'field' ? 6 : 5);
  assert.ok(prRef !== undefined, 'Automated review needs the PR number: field ISSUE Status "Automated review" PR [OTHER_ISSUE...]');
  const positive = ref =>/^\d+$/.test(ref ?? '') && Number.isSafeInteger(Number(ref)) && Number(ref) > 0;
  assert.ok(positive(prRef) && extraIssues.every(ref => validBlocker(ref) && positive(ref.slice(ref.lastIndexOf('#') + 1))),
    'Automated review requires PR [OTHER_ISSUE...]; post and read back every issue backlink first.');
  const prNumber = Number(prRef);
  const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){number url state isDraft body}}}`, { owner, name, number: prNumber }).repository;
  assert.ok(pr?.number === prNumber && pr.state === 'OPEN' && typeof pr.body === 'string', 'The declared PR is not open/readable');
  assert.ok(pr.isDraft === false, `PR #${prNumber} is still Draft (its CI skips checks); run board.mjs done ${number}`);
  const url = new URL(pr.url);
  assert.equal(url.pathname, `/${project.repository}/pull/${prNumber}`, 'PR belongs to another repository');
  const scope = new Set([`${project.repository}#${number}`, ...extraIssues.map(ref =>
    `${blockerRepository(ref)}#${Number(ref.slice(ref.lastIndexOf('#') + 1))}`)]);
  for (const issueRef of scope) {
    const repository = blockerRepository(issueRef), issueNumber = Number(issueRef.slice(issueRef.lastIndexOf('#') + 1));
    const qualifier = `(?:${RegExp.escape(repository)})${repository === project.repository ? '?' : ''}`;
    const reference = new RegExp(`(?<![\\w/])${qualifier}#${issueNumber}(?!\\w)`, 'i');
    assert.ok(reference.test(pr.body), `PR #${prNumber} does not reference ${issueRef}`);
    let backlink = findBacklink(issueComments(repository, issueNumber), url);
    // An issue of this repository gets what `link` does (native connection and comment, read back); only a failure refuses.
    // A partial PR of this issue gets the comment only: a native link would make it a second closing PR.
    if (!backlink && repository === project.repository) {
      if (issueNumber === number && isPartialPr(issue, prNumber)) postBacklink(issueNumber, pr.url);
      else linkIssue(issueNumber, prNumber);
      backlink = findBacklink(issueComments(repository, issueNumber), url);
    }
    assert.ok(backlink, `Missing backlink to ${pr.url} on #${issueNumber}; post the full URL as a comment and retry`);
    console.log(`backlink ${issueRef}: ${backlink.html_url}`);
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

const readPr = prNumber => graphql(prQuery, { owner, name, number: prNumber }).repository.pullRequest;
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
  assert.ok(sonarHosts.includes(target.origin) && key && target.searchParams.get('pullRequest') === String(prNumber),
    `The SonarCloud check does not link PR #${prNumber}'s analysis (${detailsUrl}); open issues are unreadable`);
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
function reviews(stallMinutes = 20, now = Date.now(), prNumber = number, pr = readPr(prNumber), graceMinutes = graceOption(), threadsOf = current => unresolvedThreads(current.number, current.reviewThreads), dismissStale = false) {
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
      lines.push(`blocker: no pull_request run on the head 10 minutes after the push and the merge state is UNKNOWN; ${readStacks(pr.number).length
        ? `probably a conflict in a layer of the native stack locks it: ${stackOrderText}`
        : 'push an empty commit or push the head again'}`);
    }
  }
  // Conflicts start no workflow, so the wait would never end; the fix is merging the base now.
  // UNKNOWN (GitHub computes the state late after a push) or BEHIND are no conflict.
  if (pr.mergeStateStatus === 'DIRTY' && !pr.isDraft) {
    failed = true;
    reasons.push('merge conflicts');
    lines.push(conflictLine(pr));
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
      execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${pr.number}/reviews/${latest.id}/dismissals`, '-X', 'PUT', '-f',
        `message=All review threads are resolved on head ${short}; the change request is stale.`], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
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

/** Native PR connections, including manual links on a non-default base; refs and branches do not count. */
function connectedIssues(pr, draftAllowed = false) {
  const ids = new Set();
  for (let after; ;) {
    const current = graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){
      pullRequest(number:$number){state isDraft headRefOid closingIssuesReferences(first:100,after:$after){totalCount
        pageInfo{hasNextPage endCursor} nodes{id}}}}}`, { owner, name, number: pr.number, ...(after && { after }) })
      .repository.pullRequest;
    assert.ok(current?.state === 'OPEN' && (draftAllowed || current.isDraft === false) && current.headRefOid === pr.headRefOid,
      'PR changed after the review check; read the current head again');
    const links = current.closingIssuesReferences;
    assert.ok(links?.nodes && links.pageInfo, 'Native issue links are unreadable');
    for (const issue of links.nodes) {
      assert.ok(issue?.id && !ids.has(issue.id), 'Native issue links are incomplete or repeated');
      ids.add(issue.id);
    }
    if (!links.pageInfo.hasNextPage) {
      assert.equal(ids.size, links.totalCount, 'Not every native issue link is readable');
      return ids;
    }
    assert.ok(links.pageInfo.endCursor && links.pageInfo.endCursor !== after, 'Issue-link pagination did not advance');
    after = links.pageInfo.endCursor;
  }
}

/** The changed region of two texts as `-`/`+` lines (common start and end cut off): enough to show a person what differs. */
function diffText(before, after) {
  const [old, now] = [before, after].map(text => text.split('\n'));
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start++;
  let [endOld, endNow] = [old.length, now.length];
  while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) { endOld--; endNow--; }
  return [...old.slice(start, endOld).map(line => `- ${line}`), ...now.slice(start, endNow).map(line => `+ ${line}`)].join('\n');
}

const lines = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd();

/**
 * Replace an issue body only if it still is the one the change is based on, and prove the write afterwards.
 * GitHub has no conditional write for issue bodies: the window between the read and the write stays, which the
 * read-back closes for every overwrite that happens before it. Another session's change is reported, never lost silently.
 * `change(before, refuse)` turns the body just read into the new one; it returns undefined after calling `refuse`.
 */
function writeBody(change) {
  const current = () => {
    const issue = rest(`repos/${project.repository}/issues/${number}`);
    // The Issues API also serves pull requests under their number; a PR description is no issue body to replace.
    assert.ok(issue?.number === number && !issue.pull_request, `#${number} is not an issue of ${project.repository}`);
    return String(issue.body ?? '').replaceAll('\r\n', '\n').trimEnd();
  };
  const refuse = (reason, diff) => {
    console.log(['FAILED', `blocker: ${reason}`, diff.trimEnd()].filter(Boolean).join('\n'));
    process.exitCode = 1;
  };
  const before = current();
  const fresh = change(before, refuse);
  if (fresh === undefined) return;
  if (before === fresh) return console.log(`BODY #${number} already has this text`);
  // The text already read and compared goes over stdin: gh would take a file named "-" for stdin and write an empty body.
  execFileSync(gh.file, ['api', `repos/${project.repository}/issues/${number}`, '-X', 'PATCH', '-F', 'body=@-'],
    { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: fresh });
  const after = current();
  if (after !== fresh) return refuse(`the body of #${number} is not what was written: another session overwrote it meanwhile (diff: what you wrote, then the current body); read it, merge, write again`, diffText(fresh, after));
  console.log(`BODY #${number} written and read back`);
}

function body() {
  const [fresh, base] = [value, process.argv[5]].map(lines);
  writeBody((before, refuse) => before === base ? fresh
    : refuse(`the body of #${number} changed since you read it (diff: your base, then the current body); read it again, merge, write again`, diffText(base, before)));
}

/** Replace exactly one occurrence of the --from text with the --to text; the body just read is the base. No regular expressions. */
function bodyReplace() {
  const [from, to] = [process.argv[5], process.argv[7]].map(lines);
  assert.ok(from !== '', 'The --from text is empty');
  writeBody((before, refuse) => {
    // Every start position counts, so "aa" in "aaa" is two matches, not one.
    const starts = [];
    for (let at = before.indexOf(from); at !== -1; at = before.indexOf(from, at + 1)) starts.push(at);
    if (starts.length === 1) return before.slice(0, starts[0]) + to + before.slice(starts[0] + from.length);
    const lineOf = at => before.slice(0, at).split('\n').length;
    return refuse(starts.length === 0
      ? `the --from text is not in the body of #${number}; read the body again`
      : `the --from text occurs ${starts.length} times in the body of #${number} (from line ${starts.map(lineOf).join(', from line ')}); take more surrounding text so it matches once`, '');
  });
}

/** Connect the issue natively to the PR (what a closing keyword does only on the default branch), post the backlink comment `status` requires, and read both back. */
const link = () => linkIssue(number, Number(value), process.argv.includes('--refs'));
/** `refsOnly` (link --refs): the PR only names the issue, so no native link; the backlink comment alone (#510). */
function linkIssue(issueNumber, prNumber, refsOnly) {
  const issue = readIssue(false, issueNumber);
  assert.ok(issue?.id, 'Issue identity is unreadable');
  // The backlink comment belongs on an open issue (the guard requires one); refuse before any write instead of half-way.
  assert.equal(issue.state, 'OPEN', `#${issueNumber} is not an open issue`);
  assert.ok(refsOnly || !isSpec(issue), specRefusal(issueNumber, `a PR must not close it, so it is not linked natively (use "Refs #${issueNumber}": link ${issueNumber} PR --refs)`));
  const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$number){id number state url headRefOid}}}`, { owner, name, number: prNumber }).repository;
  assert.ok(pr?.id && pr.number === prNumber && pr.state === 'OPEN', `#${prNumber} is not an open pull request of ${project.repository}`);
  // Already connected is a success without a write; a Draft PR can be connected too.
  if (!refsOnly && !connectedIssues(pr, true).has(issue.id)) {
    graphql('mutation($issue:ID!,$pr:ID!){addCloseIssueReferences(input:{issueId:$issue,pullRequestIds:[$pr]}){clientMutationId}}',
      { issue: issue.id, pr: pr.id });
    // GitHub shows the new connection with a delay (seen live: the first read-back right after the write was empty).
    // Read back a few times; the write is never repeated.
    for (let attempt = 1; !connectedIssues(pr, true).has(issue.id); attempt++) {
      assert.ok(attempt < 5, `Native link read-back differs: PR #${prNumber} does not close issue #${issueNumber}`);
      sleep(1);
    }
  }
  console.log(refsOnly ? `#${issueNumber} is named by PR #${prNumber} (Refs, no native link)` : `#${issueNumber} is natively linked to PR #${prNumber}`);
  postBacklink(issueNumber, pr.url);
}

/** The backlink comment alone (a partial PR must not be linked natively). An existing comment is a success without a write. The text goes over stdin, like in `body`; the guard's reader proves it. */
function postBacklink(issueNumber, url) {
  const prUrl = new URL(url);
  let backlink = findBacklink(issueComments(project.repository, issueNumber), prUrl);
  if (!backlink) {
    execFileSync(gh.file, ['api', `repos/${project.repository}/issues/${issueNumber}/comments`, '-X', 'POST', '-F', 'body=@-'],
      { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: `PR: ${url}\n` });
    backlink = findBacklink(issueComments(project.repository, issueNumber), prUrl);
    assert.ok(backlink, `Backlink read-back differs: the comment with ${url} is not readable on #${issueNumber}; read the comments before writing again`);
  }
  console.log(`backlink #${issueNumber}: ${backlink.html_url}`);
}

/**
 * `done` says the issue is delivered, so every open task-list item of its body that names no issue counts as met; a part moved to a
 * follow-up stays open and carries its issue (`- [ ] … → #12`). Fenced code is left alone.
 * ponytail: works on the Markdown lines; a `#N` anywhere in the line or an issue URL counts as the follow-up reference.
 */
function tickAcceptance(text) {
  let fence = false;
  return text.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    return fence || /#\d|\/issues\/\d/.test(line) ? line : line.replace(/^(\s*(?:[-*]|\d+\.)\s+)\[ \]/, '$1[x]');
  }).join('\n');
}

/**
 * Everything the issue side of the handoff still lacks (readiness, review status, assignment) on the
 * supplied issue snapshot, or undefined when check() already printed its verdict and stopped.
 * `reviewedHead`: the PR head the proof was gathered for; a stacked layer must still be that head when this reads it.
 */
function handoffIssueReasons(issue, viewer, reviewedHead, currentPrNumber) {
  if (!mayStart(check(issue, undefined, currentPrNumber))) return;
  assert.ok(issue.id, 'Issue identity is unreadable');
  const status = projectStatus(issue);
  const reasons = [];
  // An upper layer may be handed off before the base is merged, but only as a layer on that base.
  // A merged base leaves a plain PR on the trunk; it still has to come from this repository and target that trunk.
  if (stackedOn) {
    const { pullRequest: pr } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){baseRefName headRefOid isCrossRepository headRepository{nameWithOwner}}}}`, { owner, name, number: Number(value) }).repository;
    if (reviewedHead && pr?.headRefOid !== reviewedHead) reasons.push(`PR #${value} changed its head from ${reviewedHead.slice(0, 7)} during handoff; read it again`);
    if (pr?.isCrossRepository !== false || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) reasons.push(`PR #${value} comes from a fork or another repository: stacks stay inside ${project.repository}`);
    if (stackedOn.state === 'MERGED') {
      if (pr?.baseRefName !== stackedOn.baseRefName) reasons.push(`PR #${stackedOn.number} is merged into ${stackedOn.baseRefName}: PR #${value} must target it, not ${pr?.baseRefName}`);
    } else {
      // An aligned branch chain is no stack: GitHub must list both PRs in one open stack (the read-back of the docs, step 2).
      const stacks = rest(`repos/${project.repository}/stacks?pull_request=${Number(value)}`);
      // The base PR may sit anywhere below this PR; the head and target checks below concern the layer directly under it.
      const base = { number: stackedOn.number, ref: stackedOn.headRefName, sha: stackedOn.headRefOid };
      let lower; // {number, ref, sha} of the layer directly under this PR; the base PR itself keeps its own read
      if (Array.isArray(stacks) && stacks.length === 1 && stacks[0].open === true && Array.isArray(stacks[0].pull_requests)) {
        const members = stacks[0].pull_requests;
        const baseIndex = members.findIndex(member => member.number === stackedOn.number);
        const ownIndex = members.findIndex(member => member.number === Number(value));
        const under = members[ownIndex - 1];
        if (baseIndex >= 0 && ownIndex > baseIndex) {
          if (under.number === base.number) lower = base;
          else if (typeof under.head?.ref === 'string' && typeof under.head.sha === 'string') lower = { number: under.number, ref: under.head.ref, sha: under.head.sha };
        }
      }
      if (!lower) {
        reasons.push(`PR #${value} is not above PR #${stackedOn.number} in one open native stack (GET repos/${project.repository}/stacks?pull_request=${value}); link it (docs/CONTRIBUTING.md#stacked-pull-requests) or stop`);
      }
      const { number: lowerNumber, ref: lowerRef, sha: lowerSha } = lower ?? base;
      // Proof of the upper head only counts when that head contains the lower PR's current head (a later push below leaves the branch name unchanged).
      if (!reasons.length && pr?.baseRefName === lowerRef) {
        const { status } = rest(`repos/${project.repository}/compare/${lowerSha}...${pr.headRefOid}`);
        if (!['ahead', 'identical'].includes(status)) reasons.push(`PR #${value} does not contain the current head ${lowerSha.slice(0, 7)} of PR #${lowerNumber} (compare says ${status}): rebase onto it and push with the lease`);
      }
      if (pr?.baseRefName !== lowerRef) reasons.push(`the open predecessor PR #${lowerNumber} is not merged: PR #${value} must target its branch ${lowerRef}, not ${pr?.baseRefName}`);
    }
  }
  if (!['Automated review', 'Human review'].includes(status)) reasons.push(`status is ${status ?? 'unset'}: when the work is done, run board.mjs done ISSUE`);
  if (!issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase())) {
    reasons.push(`the issue is not assigned to the authenticated driver: gh issue edit ${issue.number} --repo ${project.repository} --add-assignee "@me"`);
  }
  return reasons;
}

/** The recheck before the write: true when the issue side holds, otherwise the verdict is printed. */
function handoffIssue(issue, viewer, reviewedHead, currentPrNumber) {
  const reasons = handoffIssueReasons(issue, viewer, reviewedHead, currentPrNumber);
  if (reasons?.length) {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
  }
  return reasons?.length === 0;
}

/**
 * The driver's handoff comment: a "## Übergabe" heading and a "Head: <SHA>" line in a PR comment by the authenticated
 * user. The comment names the head it is about, so a new head asks for a new comment however (and whenever) the push
 * happened, which no timestamp reliably tells. With several matching comments the newest counts.
 */
const findHandoffComment = (comments, viewer, headRefOid) => comments.findLast(comment => comment.user?.login?.toLowerCase() === viewer.login.toLowerCase()
  && /^## Übergabe\s*$/m.test(comment.body ?? '') && new RegExp(`^Head:\\s*${headRefOid.slice(0, 7)}`, 'im').test(comment.body ?? ''));

// ponytail: relies on GitHub's markup (h1-h6, li, issue-link); replace when GitHub changes it.
const text = html => html.replace(/<\/?(?:br|p|div|li|h[1-6]|ul|ol|blockquote)\b[^>]*>/gi, ' ')
  .replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const headingText = part => text(part.match(/^<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/)?.[1] ?? '');
/** A quoted template is no section: drop quotes (innermost first, so nesting works) before searching. */
function withoutQuotes(html) {
  let unquoted = html;
  for (let previous; previous !== unquoted;) { previous = unquoted; unquoted = unquoted.replace(/<blockquote[\s>](?:(?!<blockquote[\s>])[\s\S])*?<\/blockquote>/g, ''); }
  return unquoted;
}

/**
 * Why the PR body, as GitHub renders it, does not carry the self-review the project asks for: the project file's
 * "selfReview" lists the checks (for example "ponytail-review", "code-review") that the section "Selbstprüfung" (a heading of
 * any level; its sub-headings belong to it) must name. Whether a check was good is not judged. Without the field nothing is asked.
 */
// ponytail: a name counts when the section mentions it, the section is not proof the check ran; replace when a check leaves a trace.
function selfReviewChecks() {
  const checks = project.selfReview === undefined ? [] : project.selfReview; // only a missing field is allowed; null is malformed
  assert.ok(Array.isArray(checks) && checks.every(check => typeof check === 'string' && check.trim()), 'selfReview must be a list of non-empty check names');
  return checks;
}
function selfReviewReasons(bodyHtml, checks) {
  if (!checks.length) return [];
  assert.equal(typeof bodyHtml, 'string', 'The rendered PR body is unreadable');
  const parts = withoutQuotes(bodyHtml).split(/(?=<h[1-6][\s>])/), level = part => Number(/^<h([1-6])[\s>]/.exec(part)?.[1]);
  const start = parts.findIndex(part => level(part) && headingText(part) === 'Selbstprüfung');
  if (start < 0) return [`the PR body needs a "## Selbstprüfung" section that names ${checks.join(', ')} (docs/CONTRIBUTING.md#review-loop, step 1)`];
  let end = start + 1;
  while (end < parts.length && level(parts[end]) > level(parts[start])) end++;
  const section = text(parts.slice(start, end).join(''));
  const missing = checks.filter(check => !new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_-])${RegExp.escape(check.trim())}(?![\\p{L}\\p{M}\\p{N}_-])`, 'iu').test(section));
  return missing.length ? [`the "Selbstprüfung" section of the PR body does not name: ${missing.join(', ')}`] : [];
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
  const blockers = reasons => reasons.map(reason => `blocker: ${reason}`);
  // Somebody else merged it while merge waited (#556): the goal is reached, so merge goes on with its steps after a merge. Handoff still needs an open PR.
  if (action === 'merge' && pr.state === 'MERGED') return { pr, merged: true };
  if (pr.state !== 'OPEN' || pr.isDraft) {
    console.log(['FAILED', ...blockers([...prior, `${action} needs an open non-draft PR`])].join('\n'));
    process.exitCode = 1;
    return;
  }
  const result = reviewed ?? reviews(stallOption(), Date.now(), prNumber, pr, undefined, undefined, action === 'handoff');
  console.log(result.lines.join('\n'));
  if (!result.done || result.failed) {
    process.exitCode = result.failed || prior.length ? 1 : 3;
    console.log([result.failed ? outcome(result)[0] : prior.length ? 'FAILED' : 'WAITING', ...blockers(prior)].join('\n'));
    return;
  }
  if (expectedHead) assert.equal(result.pr.headRefOid, expectedHead, `PR head changed during ${action}`);
  const reasons = [...prior];
  if (result.lines.some(line => line.startsWith('blocker:') || /^unresolved threads: [1-9]/.test(line))) {
    reasons.push(`resolve review blockers and threads before ${action}`);
  }
  reasons.push(...selfReviewReasons(result.pr.bodyHTML, checks), ...extra(result));
  // Handoff and merge alike: a PR text edited after the handoff must not close a spec either.
  for (const specNumber of closedSpecs(result.pr.body)) reasons.push(specRefusal(specNumber, `the text of PR #${prNumber} closes it; write "Refs #${specNumber}" instead`));
  const undetermined = state => !state || state === 'UNKNOWN';
  let state = result.pr.mergeStateStatus;
  for (let read = 1; undetermined(state) && read < mergeReads; read++) {
    sleep(numberOption('--interval', 3));
    const fresh = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
      pullRequest(number:$number){headRefOid mergeStateStatus}}}`, { owner, name, number: prNumber }).repository.pullRequest;
    assert.equal(fresh?.headRefOid, result.pr.headRefOid, `PR head changed during ${action}`);
    state = fresh.mergeStateStatus;
  }
  // The snapshot's own DIRTY is already a blocker line of reviews(); a DIRTY that GitHub computed during the re-reads is new.
  if (state === 'DIRTY' && result.pr.mergeStateStatus !== 'DIRTY') reasons.push('merge conflicts: resolve them before ' + action);
  if (!mergeStates.includes(state)) {
    if (!reasons.length) {
      console.log('WAITING\nwaiting: PR mergeability is not determined');
      process.exitCode = 3;
      return;
    }
    if (undetermined(state)) reasons.push('PR mergeability is not determined (GitHub is still computing it): run again in a minute');
  }
  if (reasons.length) {
    console.log(['FAILED', ...blockers(reasons)].join('\n'));
    process.exitCode = 1;
    return;
  }
  return result;
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
  const result = finishedPr(Number(value), 'handoff', expectedHead, ({ comments, pr }) => {
    const reasons = [];
    const comment = findHandoffComment(comments, viewer, pr.headRefOid);
    if (!comment) reasons.push(`no handoff comment for head ${pr.headRefOid.slice(0, 7)} on PR #${value}: write FILE (<Ergebnis in einem Satz>, then "### Retro" with one list line per finding, or "- Keine Funde"; README: Handoff comment) and run board.mjs done ${number} FILE`);
    if (!partial && !connectedIssues(pr).has(issueId)) reasons.push(`PR #${value} is not natively linked to issue #${number}`);
    return reasons;
  }, prior);
  return result?.pr;
}

/** Guard the Human review write with current PR proof followed by current issue prerequisites. */
function handoff() {
  const issue = readIssue();
  const { viewer } = graphql('query{viewer{login}}');
  assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
  // The issue side's reasons wait for the PR side's, so one run names everything that is missing.
  const currentPrNumber = Number(value);
  // A partial PR (see isPartialPr) has only the PR gate: no native link, and the issue's status and assignment are not its business, since the closing PR hands the issue off.
  // `--refs` is the same for a PR that only names the issue, whether or not another PR closes it (#510).
  const partial = process.argv.includes('--refs') || isPartialPr(issue, currentPrNumber);
  const prior = partial ? [] : handoffIssueReasons(issue, viewer, undefined, currentPrNumber);
  if (!prior) return;
  const pr = handoffPr(issue.id, viewer, undefined, prior, partial);
  if (!pr) return;
  if (partial) return console.log(`HANDOFF #${number} PR #${value} head ${pr.headRefOid} (partial PR: the issue status stays, the closing PR hands it off)`);
  if (!set('Status', 'Human review', () => {
    if (!handoffPr(issue.id, viewer, pr.headRefOid)) return;
    const current = readIssue();
    assert.equal(current?.id, issue.id, 'Issue identity changed during handoff');
    return handoffIssue(current, viewer, pr.headRefOid, currentPrNumber) ? current : undefined;
  })) return;
  assert.equal(projectItem(readIssue())?.status?.name, 'Human review', 'Human review status read-back differs');
  console.log(`HANDOFF #${number} PR #${value} head ${pr.headRefOid}`);
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
let stackOrder = [], stackTrunk;
const stackLayers = new Map();

/** Why one layer of the stack does not hold the gate of `handoff` (CI and reviewers are the top head's business only): handoff comment for its head, threads, change requests, issue status. */
function layerReasons(layer, viewer) {
  const pr = readPr(layer);
  if (pr.state !== 'OPEN' || pr.isDraft) return ['is not an open, non-draft PR'];
  const reasons = [];
  if (!findHandoffComment(restAll(`repos/${project.repository}/issues/${layer}/comments`), viewer, pr.headRefOid)) {
    reasons.push(`has no handoff comment for head ${pr.headRefOid.slice(0, 7)} (a "## Übergabe" heading and a "Head: ${pr.headRefOid.slice(0, 7)}" line)`);
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
    if (status !== 'Human review') reasons.push(`delivers issue #${issueNumber}, whose status is ${status ?? 'unset'}, not Human review`);
  }
  stackLayers.set(layer, { pr, issues: nodes.map(issue => issue.number) });
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
  stackOrder = open.map(member => member.number);
  stackTrunk = stacks[0].base.ref;
  const reasons = stackOrder.flatMap(layer => layerReasons(layer, viewer).map(reason => `PR #${layer} ${reason}`));
  // GitHub merges each layer by its own head: a layer pushed after the one above it was built would merge on its own. Same rule as handoff.
  stackOrder.slice(1).forEach((upper, index) => {
    const lower = stackOrder[index], heads = [lower, upper].map(layer => stackLayers.get(layer)?.pr.headRefOid);
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

/**
 * Merge the moved base into the PR branch (update-branch, only if the head is still `head`), then wait until the PR shows the new head.
 * GitHub answers 403 for a PR with stacked children (#321): that ends the run with the manual way (nobody pushes for the caller) and returns nothing.
 */
function updateBranch(head, base) {
  try {
    execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${number}/update-branch`, '-X', 'PUT', '-f', `expected_head_sha=${head}`], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  } catch (error) {
    // stdio 'pipe': without it execFileSync copies gh's raw refusal to stderr, and a caller that reads the last line sees that, not the instruction (#332).
    if (!/\b403\b|stacked PR's branch/.test(`${error.stderr}${error.stdout}`)) throw error;
    console.log(['FAILED', `blocker: GitHub refuses the branch update with 403 (typical for a PR with stacked children): run \`git merge origin/${base}\` in the PR's worktree, push once, then run \`board.mjs merge ${number}\` again`].join('\n'));
    process.exitCode = 1;
    return;
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
 * `main` has it as head), or the base of an open PR (a stack: GitHub would close that PR). Returns the line to print.
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
    execFileSync(gh.file, ['api', `repos/${project.repository}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, '-X', 'DELETE'], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  } catch (error) {
    // A branch that is already gone (the repository deletes merged branches itself) is no failure.
    if (!/\b(404|422)\b|Reference does not exist|Not Found/.test(`${error.stderr}${error.stdout}`)) throw error;
    return `branch gone: ${branch}`;
  }
  return `branch deleted: ${branch}`;
}


/** One shell command of the project file in `cwd`, output passed through; throws on a non-zero exit. `execPath` is `git --exec-path`. */
function runShell(execPath, cwd, command, env) {
  const bash = process.platform === 'win32' ? resolve(execPath, '..', '..', '..', 'bin', 'bash.exe') : '/bin/bash';
  execFileSync(bash, ['-c', command], { cwd, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true, timeout: 30 * 60_000 });
}

/**
 * After a merge into main or a release branch the `push` commands of `.github/workflow-project.json` as on the merge commit run here, in the
 * foreground (sweep, release sync, pin); after a merge in the kit (`--cwd <project>/.vendor/workflow-kit`) the `kitPush` commands of the project that
 * holds it as its submodule, as on its main. They run with BRANCH in a throwaway worktree on that commit, without setup (only the kit submodule is
 * fetched), and a project without such commands touches no git at all. A merge is never undone by a failure here.
 * ponytail: the commands run in bash, on Windows the one of Git for Windows (not WSL's), elsewhere /bin/bash; the 30 minutes kill bash, not the children it started;
 * replace when a project needs another shell or tree-kill.
 */
function runPush(branch, merged) {
  if (!merged || (branch !== 'main' && !branch.startsWith('release/'))) return;
  const here = resolve(projectDirectory), superproject = basename(dirname(here)) === '.vendor' ? dirname(dirname(here)) : ''; // the kit sits in <project>/.vendor/workflow-kit
  if (superproject && branch !== 'main') return;
  let work, root;
  const run = (cwd, ...args) => {
    const tool = externalTool('git', process.cwd(), cwd);
    return execFileSync(tool.file, ['-C', cwd, ...args], { encoding: 'utf8', env: tool.env, stdio: 'pipe' }).trim();
  };
  try {
    root = superproject || projectDirectory;
    const repository = superproject ? JSON.parse(readFileSync(join(root, '.github/workflow-project.json'), 'utf8')).repository : project.repository;
    const file = rest(`repos/${repository}/contents/.github/workflow-project.json?ref=${superproject ? 'main' : merged}`);
    const commands = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))[superproject ? 'kitPush' : 'push'] ?? [];
    if (!commands.length) return;
    run(root, 'fetch', '--quiet', 'origin', branch);
    const sha = superproject ? run(root, 'rev-parse', `refs/remotes/origin/${branch}`) : merged;
    work = mkdtempSync(join(tmpdir(), 'board-push-'));
    run(root, 'worktree', 'add', '--quiet', '--detach', work, sha);
    if (run(work, 'ls-files', '--stage', '--', '.vendor/workflow-kit').startsWith('160000')) run(work, 'submodule', 'update', '--init', '.vendor/workflow-kit'); // the scripts need the kit
    for (const command of commands) runShell(run(root, '--exec-path'), work, command, { BRANCH: branch });
  } catch (error) {
    console.log(`note: the push commands of ${branch} failed (${String(error.message).split('\n')[0]})`);
  } finally {
    if (work) try { rmSync(work, { recursive: true, force: true }); run(root, 'worktree', 'prune'); } catch { /* only tidiness */ }
  }
}

/**
 * Merge for agents with merge authority: the same gate as handoff (CI, every traced review finished, no blocker or open
 * thread). A single PR is merged as it is, whatever the base gained since (#552); only a red check can ask for the base first (below).
 * Then exactly the checked head: `--match-head-commit` needs the full object id, and it also refuses a push that lands after the check, so
 * no recheck window is left to close. Never repeated: a refusal by gh ends as ERROR, except the stack refusal of a PR with stacked children (#321),
 * which goes once to merge-async with the same head and is read back until merged. Afterwards the head branch goes (see deleteHeadBranch).
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
    if (reasons.length) {
      console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
      process.exitCode = 1;
      return;
    }
  }
  const look = () => reviews(stallOption());
  // Like `wait`: look again until CI and the reviewers have finished (or --max-minutes runs out: exit 4); the gate then decides once.
  let polled = await poll(look);
  if (!polled) return;
  // The new head's CI (and any reviewer that answers the push) decides, so the gate runs again; one update per run.
  const update = async ({ baseRefName, headRefOid: before }, why) => {
    assert.match(before, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
    console.log(`update: ${why}; merging ${baseRefName} into the PR branch first`);
    const updated = updateBranch(before, baseRefName);
    if (!updated) return false;
    console.log(`updated: head ${before.slice(0, 7)} -> ${updated.slice(0, 7)}; waiting for CI`);
    polled = await poll(look);
    return Boolean(polled);
  };
  // A red check from "updateBranchChecks" as the only reason asks for the base (#383): that is the update, not a FAILED.
  // Any other red check on a head the base has left behind may come from the old merge state (#425): the base is merged once and the new CI decides; a second red is FAILED.
  const stale = !stack && polled.failed && !polled.baseOnly && polled.reasons.every(reason => reason.startsWith('check ')) ? baseMovement(polled.pr) : null;
  const forCheck = !stack && (polled.baseOnly || stale);
  if (forCheck && !await update(polled.pr, stale ? `${polled.pr.baseRefName} gained ${stale.behind} commits since the merge-base; ${polled.reasons.join('; ')}` : polled.reasons.join('; '))) return;
  // The successful poll just checked this head; an update above replaces that proof before the atomic head-bound merge.
  const result = mergeGate(viewer, polled);
  if (!result) return;
  assert.match(result.pr.headRefOid, /^[0-9a-f]{40}$/, 'The PR head is not a full object id');
  const moved = stack ? baseMovement({ ...result.pr, baseRefName: stackTrunk }) : null;
  if (moved?.shared.length) {
    console.log(['FAILED', `blocker: ${stackTrunk} gained ${moved.behind} commits that change ${filesText(moved.shared)} like this stack: run \`git merge origin/${stackTrunk}\` in the top layer's worktree, push once, then run \`board.mjs merge ${number} --stack\` again`].join('\n'));
    process.exitCode = 1;
    return;
  }
  const { headRefOid } = result.pr;
  let asynchronous = false;
  const mergeAsync = () => {
    // Without the version header GitHub answers 404 for a stacked PR (#492); direct_merge is still a valid merge_action with it. The result is read from the PR below.
    execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${number}/merge-async`, '-X', 'PUT', '-H', 'X-GitHub-Api-Version: 2026-03-10', '-f', 'merge_action=direct_merge', '-f', 'merge_method=merge', '-f', `sha=${headRefOid}`],
      { encoding: 'utf8', env: gh.env });
    asynchronous = true;
  };
  // A stack is merged by GitHub from its top, and a plain `gh pr merge` of the top would land it in the layer below: merge-async only.
  if (result.merged) console.log(`note: PR #${number} is already merged`); else if (stack) mergeAsync(); else try {
    execFileSync(gh.file, ['pr', 'merge', String(number), '--repo', project.repository, '--merge', '--match-head-commit', headRefOid],
      { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  } catch (error) {
    // A PR with stacked children (#321) is refused, but accepted by merge-async: same merge, same head, the answer is 202 and the merge follows in the background.
    // GitHub's GraphQL text is "part of a stack and must be merged using the asynchronous merge REST API"; a REST merge answers HTTP 403.
    // ponytail: a bare HTTP 403 (e.g. a token without permission) also tries merge-async once, which then ends as ERROR; add a stack qualifier when a real 403 text is captured.
    const text = `${error.stderr}${error.stdout}`;
    if (!/part of a stack|asynchronous merge REST API|HTTP 403/i.test(text)) throw error;
    console.log(`note: gh pr merge was refused (${/HTTP 403/i.test(text) ? 'HTTP 403' : 'part of a stack'}); merging the same head with merge-async`);
    mergeAsync();
  }
  // The merge is done and read back: nothing about the branch may turn it into an ERROR.
  const dropBranch = pr => {
    try { console.log(deleteHeadBranch(pr)); } catch (error) {
      console.log(`note: branch ${pr.headRefName} not deleted (${String(error.stderr || error.message).trim()})`);
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
  console.log(`MERGED #${number} head ${headRefOid} merge commit ${mergeCommit?.oid}`);
  // The layers below: GitHub marks each as merged with the top; one line per layer, its issues and head branch (the top's goes below).
  for (const layer of stack ? stackOrder : []) {
    const { pr, issues } = stackLayers.get(layer);
    if (layer !== number) {
      const lower = readMerged(layer, true);
      console.log(`${lower.state === 'MERGED' ? 'MERGED' : `NOT MERGED (${lower.state})`} #${layer} head ${pr.headRefOid} merge commit ${lower.mergeCommit?.oid}`);
      if (lower.state !== 'MERGED') process.exitCode = 2;
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
          execFileSync(gh.file, ['api', `${path}/comments`, '-X', 'POST', '-F', 'body=@-'],
            { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: `Geschlossen von \`board.mjs merge --stack\`: PR #${layer} ist in ${stackTrunk} gemergt, GitHub hat das Issue nicht selbst geschlossen.\n` });
          execFileSync(gh.file, ['api', path, '-X', 'PATCH', '-f', 'state=closed', '-f', 'state_reason=completed'], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
        }
        console.log(`issue #${issueNumber} (PR #${layer}): closed`);
      } catch (error) { console.log(`note: issue #${issueNumber} (PR #${layer}) not handled (${String(error.stderr || error.message).trim()})`); }
    }
  }
  dropBranch(result.pr);
  runPush(stack ? stackTrunk : result.pr.baseRefName, mergeCommit?.oid);
}

const numberOption = (flag, fallback) => process.argv.includes(flag) ? Number(process.argv[process.argv.indexOf(flag) + 1]) : fallback;
const stallOption = () => numberOption('--stall', 20);
const stack = process.argv.includes('--stack');
// "reviewerGraceMinutes" in the project file is the default of --grace; 0 turns the grace off. Only a missing field is allowed.
const projectGrace = project.reviewerGraceMinutes === undefined ? 3 : project.reviewerGraceMinutes;
const graceOption = () => numberOption('--grace', projectGrace);
const headOption = () => process.argv.includes('--head') ? process.argv[process.argv.indexOf('--head') + 1] ?? '' : undefined;
// The own session for start, check and next alike: `--session`, else the `agent-<id>` of a Claude Code worktree, else CODEX_THREAD_ID, else CLAUDE_CODE_SESSION_ID (the session itself, not a subagent).
const sessionOption = () => (process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : undefined)
  ?? (process.env.CODEX_THREAD_ID || /[\\/]agent-(\w+)(?:[\\/]|$)/.exec(process.cwd())?.[1] || process.env.CLAUDE_CODE_SESSION_ID);

/** Metadata that can still describe the previous push right after it: identity, branch, state, draft, head. */
const readyQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  id number state isDraft isCrossRepository headRefOid headRepository{nameWithOwner}}}}`;
const sleep = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
/**
 * Polling must end: a few reads, finite pauses, at most half an hour of waiting in total (also keeps seconds * 1000
 * finite). `ready` waits in two loops (stale head before the write, read-back after it), each sleeping up to
 * (attempts - 1) times, so both count.
 */
function readyOptionsBounded() {
  const attempts = numberOption('--attempts', 6), interval = numberOption('--interval', 5);
  return Number.isInteger(attempts) && attempts >= 1 && attempts <= 100 && Number.isFinite(interval) && interval >= 0
    && 2 * attempts * interval <= 1800;
}

/** Mark a Draft PR ready only for the explicitly expected pushed commit; stale metadata is waited out, never trusted. */
function ready(prNumber = number, sha = value) {
  const attempts = numberOption('--attempts', 6), interval = numberOption('--interval', 5);
  const read = () => {
    const pr = graphql(readyQuery, { owner, name, number: prNumber }).repository.pullRequest;
    assert.ok(pr?.id && pr.number === prNumber, 'The PR is unreadable');
    assert.equal(typeof pr.isDraft, 'boolean', 'PR draft state is unreadable');
    return pr;
  };
  const refuse = (...reasons) => {
    console.log(['FAILED', ...reasons.map(reason => `blocker: ${reason}`)].join('\n'));
    process.exitCode = 1;
  };
  let pr;
  for (let attempt = 1; ; attempt++) {
    pr = read();
    if (pr.state !== 'OPEN') return refuse(`PR #${prNumber} is ${pr.state.toLowerCase()}`);
    // A fork's or another repository's branch is not ours to mark ready.
    // GitHub reports the canonical spelling; the configured OWNER/REPO may differ in case.
    if (pr.isCrossRepository || pr.headRepository?.nameWithOwner?.toLowerCase() !== project.repository.toLowerCase()) return refuse(`PR #${prNumber} does not come from a branch of ${project.repository}`);
    if (!pr.isDraft) {
      if (!pr.headRefOid.startsWith(sha.toLowerCase())) return refuse(`PR #${prNumber} is already ready with head ${pr.headRefOid.slice(0, 7)}, not ${sha.slice(0, 7)}`);
      return console.log(`READY #${prNumber} head ${pr.headRefOid} (already ready)`);
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
  console.log(`READY #${prNumber} head ${pr.headRefOid}`);
}
// Waiting is over either way; FAILED keeps a red head from reading as a finished review.
const outcome = ({ failed, reasons = [] }) => failed ? [['FAILED', ...reasons.length ? [reasons.join('; ')] : []].join(': '), 1] : ['DONE', 0];

/** Print one review snapshot with the same verdict and exit status as the background wait. */
function reviewsOnce() {
  const result = reviews(stallOption());
  const [word, code] = result.done ? outcome(result) : ['WAITING', 3];
  console.log([word, ...result.lines, quotaLine()].filter(Boolean).join('\n'));
  process.exitCode = code;
}

/** Waiting for the human merge is the other recurring wait; it ends when the PR is no longer open. REST, so it costs no GraphQL points. */
function mergeState() {
  const pull = rest(`repos/${project.repository}/pulls/${number}`);
  const open = pull.state === 'open';
  // Closed without merge is the end of the wait, but never a delivery.
  return { done: !open, failed: !open && !pull.merged, reasons: ['PR closed without merge'], lines: [`#${pull.number} ${open ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'}`, ...open ? ['waiting: human merge'] : []] };
}

/** What the last query cost and what is left, so a driver sees the shared quota without a command of its own. */
const quotaLine = () => quota && `quota: ${quota.remaining} left, ${spent} reported GraphQL wrapper points, ${graphqlCalls} wrapper calls, resets ${quota.resetAt}`;

/**
 * Right after a push GitHub still reports the previous head, so a plain `wait` can end DONE for it. With `--head SHA`
 * (the id just pushed, 7 to 40 characters, compared as a prefix) an open PR keeps waiting until it shows that head.
 * ponytail: a head that never matches (wrong id, someone else pushed on top) waits on; stop it by hand.
 */
function lookAtHead(pr, threads) {
  const expected = headOption()?.toLowerCase();
  if (!expected || pr.state !== 'OPEN' || pr.headRefOid.startsWith(expected)) return reviews(stallOption(), Date.now(), pr.number, pr, undefined, threads ?? (current => unresolvedThreads(current.number, current.reviewThreads)));
  return { done: false, lines: [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`,
    `waiting: PR still shows head ${pr.headRefOid.slice(0, 7)}, expected ${expected.slice(0, 7)}`] };
}

/**
 * What GraphQL shows of the PR changes only when REST shows a change too (head, state, draft, merge state, update time, check runs,
 * check suites, commit statuses), so a round that finds the same marker reads GraphQL no more: comments, reviews and reactions are
 * REST reads anyway and the clock is the current one. `head` is the commit the marker names; `pull`, `runs` and `statuses` are what
 * REST answered (pausedRound shows them). Undefined when REST cannot say.
 * ponytail: checks stop at 100 like the GraphQL query; replace when that query paginates.
 */
function changeMarker(prNumber) {
  try {
    const pull = rest(`repos/${project.repository}/pulls/${prNumber}`), commit = `repos/${project.repository}/commits/${pull.head.sha}`;
    const listed = (path, key) => rest(`${commit}/${path}?per_page=100`)[key];
    const [runs, suites, statuses] = [listed('check-runs', 'check_runs'), listed('check-suites', 'check_suites'), listed('status', 'statuses')];
    return { head: pull.head.sha, pull, runs, statuses, text: JSON.stringify([pull.head.sha, pull.updated_at, pull.state, pull.draft, pull.mergeable_state,
      runs.map(run => [run.id, run.status, run.conclusion]), suites.map(suite => [suite.id, suite.status, suite.conclusion]),
      statuses.map(status => [status.context, status.state, status.description])]) };
  } catch { return undefined; } // a failed marker read is a full read, never a verdict
}

/**
 * The GraphQL quota is used up until `resetAt`: `wait` keeps looking over REST (PR state and checks) instead of sleeping, and the
 * full read (threads, verdict) follows after the reset. It never ends the wait: REST lists every run of the head, so an older run
 * that a newer one cancelled looks failed, and only the full read knows which run decides.
 * ponytail: counts only, no verdict from REST; replace when the decisive run per job can be told apart over REST.
 */
function pausedRound(resetAt, marker) {
  const lines = [];
  let text = `GitHub quota used up until ${untilText(resetAt)}; threads and the verdict are read after it`;
  if (marker) {
    useBaseSettings({ baseRefName: marker.pull.base.ref }); // no look at the PR has happened yet in this round: the optional list must not come from the checkout
    const checks =[...marker.runs.filter(run => !isOptional(run.app?.slug)).map(run => run.status === 'completed' ? run.conclusion : 'pending'),
      ...marker.statuses.map(status => status.state)];
    const count = names => checks.filter(result => names.includes(result)).length;
    text += `; checks over REST: ${count(['pending'])} pending, ${count(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])} failed or cancelled, ${count(['success', 'neutral', 'skipped'])} passed`;
    lines.unshift(`#${marker.pull.number} ${marker.pull.state.toUpperCase()} head ${marker.head.slice(0, 7)}`);
  }
  return { done: false, lines: [...lines, `waiting: ${text}`], pausedUntil: resetAt };
}

// The last full read of this wait: the marker REST showed before it, the PR and the unresolved threads.
let lastRead;
// A full read is repeated after this long even without a change, so a GraphQL answer that lagged behind REST heals.
const fullReadEvery = 5 * 60_000;

/**
 * One round of `wait`. An unchanged marker answers from the last full read, brought up to date by the REST reads and the clock, and only
 * while it still says "waiting": every end (DONE, FAILED, a closed PR) is confirmed by a full read, whose result is what is printed.
 * Review thread resolutions leave no mark in REST, which is why no end is taken from the cache.
 */
function reviewsForHead(prNumber = number) {
  const marker = changeMarker(prNumber), started = Date.now();
  try {
    if (marker && lastRead?.marker?.text === marker.text && started - lastRead.at < fullReadEvery) {
      const result = lookAtHead(lastRead.pr, () => lastRead.threads);
      if (!result.done) return result;
    }
    const pr = readPr(prNumber), result = lookAtHead(pr);
    // A PR that shows another head than REST is still catching up, and a result that ended early has no threads: read both again next round.
    lastRead = marker && pr.headRefOid === marker.head && result.threads && { marker, pr, threads: result.threads, at: started };
    return result;
  } catch (error) {
    if (error instanceof QuotaPause) return pausedRound(error.resetAt, marker);
    throw error;
  }
}

/** Looks again and again until `look` is done and returns that result; returns nothing after printing "still waiting" (exit 4). */
async function poll(look) {
  const maxMinutes = numberOption('--max-minutes', 9);
  // One deadline per run, counted from its start (`done` runs the targeted tests first; `merge` polls twice): everything must fit the one tool call.
  if (maxMinutes > 0 && deadline === Infinity) deadline = startedAt + maxMinutes * 60_000;
  let shown, quiet = 0;
  // Exit 4: not finished, call the command again (a driver's tool call must end before its 10-minute limit).
  const stillWaiting = resetAt => {
    process.exitCode = 4;
    const quotaReset = resetAt ?? (command === 'wait' && quota?.remaining < sleepers.wait ? quota.resetAt : undefined);
    console.log(['WAITING', shown, `still waiting: call ${command} again${quotaReset ? ` after ${quotaReset} (GitHub quota pause)` : ''}`, quotaLine()].filter(Boolean).join('\n'));
  };
  try {
    for (;;) {
      const result = look(), { done, lines } = result;
      if (done) return result;
      // Interim output names what is still awaited, once per change, so a background run is never silent.
      const waiting = lines.filter(line => line.startsWith('waiting:')).join('\n');
      if (waiting !== shown) {
        console.log(['WAITING', shown = waiting, quotaLine()].filter(Boolean).join('\n'));
        quiet = 0;
      }
      if (Date.now() >= deadline) return stillWaiting(result.pausedUntil);
      // Little quota lengthens the pause, but not while REST is read in place of GraphQL.
      const pause = ['wait', 'merge'].includes(command) && process.argv.includes('--interval') ? numberOption('--interval', 0) : waitInterval(quiet++, result.pausedUntil ? undefined : quota?.remaining);
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * pause, deadline - Date.now())));
    }
  } catch (error) {
    if (!(error instanceof StillWaiting)) throw error;
    stillWaiting(error.resetAt);
  }
}

async function wait() {
  const result = await poll(process.argv.includes('--merged') ? mergeState : reviewsForHead);
  if (!result) return;
  const [word, code] = outcome(result);
  process.exitCode = code;
  console.log([word, ...result.lines, quotaLine()].filter(Boolean).join('\n'));
}

/**
 * Returns once the GraphQL quota has as many points as `wait` needs (300), so a driver never builds its own loop around `gh`: a
 * refused `gh api graphql` prints the error and may still exit 0. The reset comes from the headers of the answer; after --max-minutes
 * the command ends "still waiting" (exit 4) with the reset time, like `wait`.
 */
async function quotaWait() {
  const result = await poll(() => {
    for (;;) {
      graphql('query{viewer{login}}'); // sleeps first while the last answer showed too few points, and again when a refusal comes
      if (!(quota?.remaining < sleepers[command])) return { done: true }; // an answer without headers is an answer
      sleepUntilReset(quota.resetAt);
    }
  });
  if (result) console.log(['DONE', quotaLine()].join('\n'));
}

// OWNER/REPO#N names a blocker in another repository; N or #N one in this project's repository.
const blockerRepository = reference => reference.includes('/') ? reference.slice(0, reference.lastIndexOf('#')) : project.repository;
const validBlocker = reference => /^\d+$/.test(reference.slice(reference.lastIndexOf('#') + 1))
  && /^[\w.-]+\/[\w.-]+$/.test(blockerRepository(reference));

function block() {
  const [blockerOwner, blockerName] = blockerRepository(value).split('/');
  const blockerNumber = value.slice(value.lastIndexOf('#') + 1);
  const { id } = named(`${blockerOwner}/${blockerName}#${blockerNumber}`, () => graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id}}}`,
    { owner: blockerOwner, name: blockerName, number: Number(blockerNumber) }).repository.issue ?? assert.fail('issue not found'));
  graphql(`mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{number}}}`,
    { issue: readIssue().id, blocker: id });
  console.log(`${project.repository}#${number} is blocked by ${blockerOwner}/${blockerName}#${blockerNumber}`);
}

// Attaches CHILD as a native sub-issue of ISSUE and reads the parent link back; an existing link is a success.
function sub() {
  const [childOwner, childName] = blockerRepository(value).split('/');
  const childNumber = Number(value.slice(value.lastIndexOf('#') + 1));
  const read = () => named(`${childOwner}/${childName}#${childNumber}`, () => graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id parent{number repository{nameWithOwner}}}}}`,
    { owner: childOwner, name: childName, number: childNumber }).repository.issue ?? assert.fail('issue not found'));
  const underParent = ({ parent }) => parent?.number === number && parent.repository.nameWithOwner.toLowerCase() === project.repository.toLowerCase();
  const child = read();
  // Without replaceParent GitHub refuses a child that already has another parent; that error is left to surface.
  if (!underParent(child)) graphql(`mutation($issue:ID!,$sub:ID!){addSubIssue(input:{issueId:$issue,subIssueId:$sub}){issue{number}}}`,
    { issue: readIssue().id, sub: child.id });
  assert.ok(underParent(read()), `#${number} did not take ${value} as sub-issue (read-back shows another parent)`);
  console.log(`${project.repository}#${number} has sub-issue ${childOwner}/${childName}#${childNumber}`);
}

const restPost = (path, args, input) => execFileSync(gh.file, ['api', path, '-X', 'POST', ...args], { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input });
const sameLogin = (a, b) => a?.toLowerCase() === b?.toLowerCase();

/**
 * `start ISSUE`: everything from Ready to a Draft PR that closes the issue; the PR is the claim (its body names the session). The check of the issue decides first
 * (BLOCKED, UNKNOWN: nothing is written), then assignment, In progress, the issue-linked branch on the right base (the Project's base field, the base PR of a stack, else the default
 * branch), the kit at its pin and a Draft PR with its link; every write is read back. A step that is already done is skipped, so a resume is the same call.
 * The session is the one of `sessionOption`.
 */
function start() {
  const agent = process.env.CODEX_THREAD_ID ? 'codex' : 'claude', modules = join(projectDirectory, '.gitmodules');
  const session = sessionOption();
  assert.match(session ?? '', /^\w[\w.-]*$/, 'start needs your session id: pass --session ID');
  // One checkout-wide setting each, so a kit commit never rides along with a project push and a branch switch follows the kit pin.
  if (existsSync(modules)) for (const [key, want] of [['submodule.recurse', 'true'], ['push.recurseSubmodules', 'no']]) {
    const read = () => { try { return git('config', '--get', key); } catch { return ''; } };
    if (read() !== want) git('config', '--local', key, want);
    assert.equal(read(), want, `${key} must be ${want} but is overridden outside this clone's config; fix that override`);
  }
  const issue = readIssue();
  assert.ok(!isSpec(issue), specRefusal(number, 'start is refused; agents leave specs untouched'));
  const takeover = process.argv.includes('--takeover');
  // --takeover without an open PR would claim, branch and open an empty Draft PR (#564): refuse before anything is written.
  // A foreign assignee without a PR yet is what --takeover takes over then (#572).
  if (takeover && !openPr(issue) && !foreignAssignees(issue).length) {
    const merged = issue.closedByPullRequestsReferences?.nodes.find(pr => pr?.state === 'MERGED');
    assert.fail(`--takeover: no open PR closes #${number}${merged ? ` (PR ${refOf(merged.repository, merged.number)} is already merged)` : ''}`);
  }
  if (!mayStart(check(issue, { session, takeover }))) return;
  const stacked = stackedOn, login = issue.viewer.login;
  // The check took seconds: whoever claimed the issue meanwhile wins, nothing is written yet (#572).
  const raced = startReasons(readIssue(), session, takeover).blocked;
  if (raced.length) assert.fail(`${raced.join('; ')}; changed while starting, nothing was written`);
  if (!issue.assignees.nodes.some(user => sameLogin(user.login, login))) restPost(`repos/${project.repository}/issues/${number}/assignees`, ['-f', `assignees[]=${login}`]);
  set('Status', 'In progress');
  const base = stacked ? (stacked.state === 'MERGED' ? stacked.baseRefName : stacked.headRefName)
    : baseOf(issue).branch || (defaultBranch ??= rest(`repos/${project.repository}`).default_branch);
  // Only a session claim or an allowed takeover proves branch ownership; the agent prefix does not.
  const current = openPr(issue);
  const continued = current && (claimOf(current)?.[2] === session || takeover || isStale(issue)) ? current : undefined;
  if (continued) assert.ok(continued.headRefName, 'The claimed PR branch is unreadable');
  const taken = continued?.headRefName;
  const stem = `${agent}/${number}-${issue.title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')}`;
  const localBranchExists = name => {
    try { git('rev-parse', '--verify', '--quiet', `refs/heads/${name}`); return true; } catch { return false; }
  };
  let branch = taken ?? stem;
  for (let suffix = 1; !taken && (workBranches(issue).includes(branch) || localBranchExists(branch)
    || git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)); suffix++) {
    branch = `${stem}-${session}${suffix === 1 ? '' : `-${suffix}`}`;
  }
  if (!taken && !workBranches(issue).includes(branch)) execFileSync(gh.file, ['issue', 'develop', String(number), '--repo', project.repository, '--name', branch, '--base', base], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
  git('fetch', 'origin');
  if (git('branch', '--show-current') !== branch) {
    const local = Boolean(taken) && localBranchExists(branch);
    // --takeover (#550): the predecessor's worktree may still hold the branch; it belongs to nobody after the takeover.
    git('switch', ...takeover ? ['--ignore-other-worktrees'] : [], ...local ? [branch] : ['--track', `origin/${branch}`]);
    // The predecessor may have pushed from another clone: catch up when that is a fast-forward, else leave the branch as it is.
    if (takeover && local) try { git('merge', '--ff-only', `origin/${branch}`); } catch { /* diverged: the driver decides */ }
  }
  if (existsSync(modules) && readFileSync(modules, 'utf8').includes('.vendor/workflow-kit')) git('submodule', 'update', '--init', '.vendor/workflow-kit');
  let pr = currentIssuePr(issue).number;
  const claimLine = `Agent: ${agent}, Session: ${session}`;
  if (pr === undefined) {
    // GitHub opens no PR without a commit of its own: the first one only says that the work began. --only: changes already staged stay staged, they are the driver's to commit.
    if (git('rev-list', '--count', `origin/${base}..HEAD`) === '0') git('commit', '--allow-empty', '--only', '-m', `Arbeit an #${number} beginnen`);
    git('push', '--set-upstream', 'origin', branch);
    pr = JSON.parse(restPost(`repos/${project.repository}/pulls`, ['-f', `title=${issue.title}`, '-f', `head=${branch}`, '-f', `base=${base}`, '-F', 'draft=true', '-F', 'body=@-'], `Closes #${number}\n${claimLine}\n`)).number;
    linkIssue(number, pr);
  } else if (!ownPr(issue, session)) {
    // A stale PR of another session is taken over: the claim line in its body names this session from now on.
    const path = `repos/${project.repository}/pulls/${pr}`, body = rest(path).body ?? '';
    execFileSync(gh.file, ['api', path, '-X', 'PATCH', '-F', 'body=@-'], { encoding: 'utf8', env: gh.env, maxBuffer: 16 << 20, input: claimField.test(body) ? body.replace(claimField, claimLine) : `${body}\n${claimLine}\n` });
    assert.equal(claimOf(rest(path))?.[2], session, 'Claim in the PR body read-back differs');
  }
  const final = readIssue();
  assert.equal(projectItem(final)?.status?.name, 'In progress', 'In progress status read-back differs');
  assert.ok(final.assignees.nodes.some(user => sameLogin(user.login, login)), 'Assignment read-back differs');
  // The project's setup (e.g. its dependencies) runs last, on the branch with the kit at its pin; a failure leaves claim, status and PR, so start again resumes.
  if (project.setup) try { runShell(git('--exec-path'), projectDirectory, project.setup, { BRANCH: branch }); } catch (error) { assert.fail(`setup failed (${String(error.message).split('\n')[0]}); assignment, status and PR stay: fix it and run start again`); }
  console.log(`START #${number} session ${session} branch ${branch} base ${base} PR #${pr}${stacked && stacked.state !== 'MERGED' ? ` (stack: keep the empty claim unlinked; after the first source diff, link it above PR #${stacked.number} before done, docs/CONTRIBUTING.md#stacked-pull-requests)` : ''}`);
}

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
  const args = process.argv.slice(4), skipAt = args.indexOf('--skip-local-tests');
  const skipReason = skipAt < 0 ? undefined : args[skipAt + 1]?.trim();
  assert.ok(skipAt < 0 || (skipReason && !skipReason.startsWith('--')), '--skip-local-tests needs a non-empty reason');
  const words = args.filter((arg, index) => !arg.startsWith('--') && !['--max-minutes', '--skip-local-tests'].includes(args[index - 1]));
  const given = /^\d+$/.test(words[0] ?? '') ? Number(words.shift()) : undefined, file = words.shift();
  assert.ok(!words.length, 'done takes ISSUE [PR] [FILE]');
  const issue = readIssue(), found = currentIssuePr(issue);
  const prNumber = given ?? found.number;
  // No open PR but a FILE: a check task whose PR is already closed (or never opened) takes the way of the PR without a change.
  if (prNumber === undefined) assert.ok(file && !found.unknown, found.unknown ?? `no open PR closes #${number}: run board.mjs start ${number}, name the PR (done ${number} PR), or name the FILE with the result for the issue`);
  const pull = prNumber === undefined ? undefined : rest(`repos/${project.repository}/pulls/${prNumber}`);
  const partial = prNumber !== undefined && (process.argv.includes('--refs') || isPartialPr(issue, prNumber));
  assert.ok(partial || !isSpec(issue), specRefusal(number, 'done is refused; agents leave specs untouched (use --refs for a partial PR)'));
  const fail = reason => { console.log(`FAILED\nblocker: ${reason}`); process.exitCode = 1; };
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
    } catch (error) { return fail(`cannot confirm no-change evidence for PR #${prNumber}: ${String(error.stderr || error.message).trim()}; run done again`); }
    // Prepare and FILE can straddle a human merge: refresh closure immediately before the first issue mutation.
    try {
      const fresh = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
        state stateReason closedByPullRequestsReferences(first:100,includeClosedPrs:true){totalCount nodes{number state mergeCommit{oid} repository{nameWithOwner}}}}}}`,
      { owner, name, number }).repository.issue;
      assert.ok(fresh && ['OPEN', 'CLOSED'].includes(fresh.state), 'issue closure state is unreadable');
      const linked = currentIssuePr(fresh);
      assert.ok(!linked.unknown, linked.unknown);
      if (fresh.state === 'CLOSED') {
        assert.equal(fresh.stateReason, 'COMPLETED', 'closed issue is not confirmed completed');
        const merged = fresh.closedByPullRequestsReferences.nodes.find(pr => pr.state === 'MERGED'
          && pr.repository?.nameWithOwner?.toLowerCase() === project.repository.toLowerCase());
        assert.ok(Number.isSafeInteger(merged?.number) && merged.number > 0 && /^[a-f0-9]{40}$/.test(merged.mergeCommit?.oid ?? ''), 'closed issue has no readable linked merged PR');
        return console.log(`ALREADY DONE #${number}: closed as completed; PR #${merged.number} merged (${merged.mergeCommit.oid}); no changes`);
      }
      assert.equal(linked.number, prNumber, 'the open issue-linked PR changed; run done again');
    } catch (error) { return fail(`cannot confirm issue closure for #${number}: ${String(error.stderr || error.message).trim()}; no changes`); }
    restPost(`repos/${project.repository}/issues/${number}/comments`, ['-F', 'body=@-'], `## Übergabe\n\n${lines(file)}\n`);
    if (pull) execFileSync(gh.file, ['api', `repos/${project.repository}/pulls/${prNumber}`, '-X', 'PATCH', '-f', 'state=closed'], { encoding: 'utf8', env: gh.env, stdio: 'pipe' });
    writeBody(before => tickAcceptance(before));
    set('Status', 'Human review');
    return console.log(pull ? `CLOSED PR #${prNumber} (no change); the result is in the comment on #${number}` : `DONE #${number} (no PR); the result is in the comment on #${number}`);
  }
  // Validate the review destination before a base merge/push or ready mutation; backlinks still run after ready.
  if (!partial) resolveOption('Status', 'Automated review');
  // The tests of a head run once: a call that only waits (after exit 4) neither repeats them nor merges a base that moved meanwhile.
  const tested = resolve(projectDirectory, git('rev-parse', '--git-path', 'board-done-tested'));
  const isTested = () => existsSync(tested) && readFileSync(tested, 'utf8') === localHead();
  try {
    useBaseSettings({ baseRefName: pull.base.ref });
    assert.ok(gate.doneBaseMerge === undefined || ['always', 'overlap'].includes(gate.doneBaseMerge), 'doneBaseMerge must be always or overlap; omit it for always');
  } catch (error) { return fail(`cannot read the base-merge policy: ${error.message}`); }
  // An untested head applies the target base's policy (#558, #579). A conflict is aborted, the branch stays as it was.
  if (!isTested()) {
    const base = `origin/${pull.base.ref}`, failure = error => String(error.stderr || error.message).trim();
    // Only the PR's own branch of this repository is merged into and pushed.
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (branch !== pull.head.ref || pull.head.repo?.full_name?.toLowerCase() !== project.repository.toLowerCase()) return fail(`the checkout is on ${branch}, not on the branch ${pull.head.ref} of ${project.repository} that PR #${prNumber} shows: check it out first`);
    try { git('fetch', 'origin'); } catch (error) { return fail(`cannot fetch the base ${base}: ${failure(error)}`); }
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
    } catch (error) { return fail(`cannot compare the base ${base}: ${failure(error)}`); }
    // A branch that has the base stays as it is ("Already up to date", no commit).
    if (mergeNeeded) {
      try { git('merge', '--no-edit', mergeTarget); } catch (error) {
        const files = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        try { git('merge', '--abort'); } catch { /* no merge was started */ }
        return fail(`merging ${base} conflicts${files.length ? ` in ${files.join(', ')}` : `: ${failure(error)}`}; merge it yourself, push, then run done again`);
      }
      try { git('push', 'origin', 'HEAD'); } catch (error) { return fail(`cannot push HEAD after merging ${base}: ${failure(error)}`); }
    }
  }
  const sha = localHead();
  // Without a file and without a comment for this head (a repeated call after exit 4 has one) `done` only prepares (#576): it runs to the end of the automated review, then stops before comment, ticking and Human review.
  const prepare = !file && !findHandoffComment(restAll(`repos/${project.repository}/issues/${prNumber}/comments`), issue.viewer, sha);
  if (skipReason) console.log(`LOCAL TESTS SKIPPED ${sha}: ${skipReason}`);
  else if (!isTested()) {
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL('affected-tests.mjs', import.meta.url)), '--cwd', projectDirectory, '--run', '--base', `origin/${pull.base.ref}`], { stdio: 'inherit' });
    } catch { return fail('the targeted tests of the changed files failed (output above); fix them, push, then run done again'); }
    writeFileSync(tested, sha);
  }
  ready(prNumber, sha);
  if (process.exitCode) return;
  value = String(prNumber);
  delivered = [value];
  const status = projectStatus(issue);
  if (partial) postBacklink(number, pull.html_url);
  // A head prepared after an earlier handoff has no handoff yet: it leaves Human review.
  else if (status !== 'Automated review' && (prepare || status !== 'Human review')) set('Status', 'Automated review');
  const result = await poll(() => reviewsForHead(prNumber));
  if (!result) return;
  if (result.failed) {
    process.exitCode = outcome(result)[1];
    return console.log([outcome(result)[0], ...result.lines, quotaLine()].filter(Boolean).join('\n'));
  }
  const head = result.pr.headRefOid;
  if (prepare) return console.log(`PREPARED #${number} head ${head.slice(0, 7)}: ${skipReason ? 'local tests skipped; ready' : 'tests, ready'} and automated review are done; no handoff comment, boxes stay open, no Human review. ${skipReason ? 'Repeat --skip-local-tests REASON to skip local tests again; then run' : 'Run the final proof, then'} board.mjs done ${number} FILE`);
  // Boxes are ticked only once the checks of the head are green.
  if (!partial) writeBody(before => tickAcceptance(before));
  if (file && !findHandoffComment(result.comments, issue.viewer, head)) {
    restPost(`repos/${project.repository}/issues/${prNumber}/comments`, ['-F', 'body=@-'], `## Übergabe\n\nHead: ${head.slice(0, 7)}\n\n${lines(file)}\n`);
  }
  handoff();
}

// check, reviews, handoff, ready and link are the steps `start` and `done` take; they stay callable for those two and for the tests, but nobody runs them by hand, so the usage leaves them out.
const commands = { start, done, next, sweep, check: () => check(readIssue(true), { session: sessionOption() }), block, sub, field: setField, new: create,
  reviews: reviewsOnce, wait, 'quota-wait': quotaWait, handoff, merge, 'stack-sync': stackSync, ready, link, body, 'body-replace': bodyReplace };
const usage = 'Usage: board.mjs [--cwd PROJECT_DIR] start ISSUE [--session ID] [--takeover: take over a fresh PR of another session] | done ISSUE [PR] [HANDOFF_FILE] [--refs] [--max-minutes N] [--skip-local-tests REASON] (without HANDOFF_FILE: prepare only, stops after the automated review)'
  + ' | next [--session ID] | sweep | field ISSUE NAME VALUE [NAME VALUE ...] [--spec-review: only a human-invoked spec-review changes spec status]'
  + ' | new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--status S] [--field NAME=VALUE ...] | new --from FILE'
  + ' | block ISSUE BLOCKER | sub PARENT CHILD | wait PR [--stall MINUTES] [--grace MINUTES] [--head SHA] [--max-minutes N] [--interval SECONDS] | wait PR --merged [--max-minutes N]'
  + ' | quota-wait [--max-minutes N] | merge PR [--stack] [--stall MINUTES] [--grace MINUTES] [--interval SECONDS (0-60)] [--max-minutes N] | stack-sync TOP'
  + ' | body ISSUE FILE BASE_FILE | body-replace ISSUE --from FILE --to FILE';
// --help (-h) is the one flag that never writes: usage on stdout, success.
if (process.argv.slice(2).some(arg => arg === '--help' || arg === '-h')) {
  console.log(usage);
  process.exit(0);
}
// A writing command takes only its own flags (value 1: followed by a value) and as many plain words as it names (the issue or PR
// included); any other argument is a mistake that must not reach a write. `field` checks its own trailing words.
const writeArgs = { start: { words: 1, flags: { '--session': 1, '--takeover': 0 } }, done: { words: 3, flags: { '--refs': 0, '--max-minutes': 1, '--skip-local-tests': 1 } },
  sweep: { words: 0 }, field: { words: Infinity, flags: { '--spec-review': 0 } }, block: { words: 2 }, sub: { words: 2 }, link: { words: 2, flags: { '--refs': 0 } },
  body: { words: 3 }, 'body-replace': { words: 1, flags: { '--from': 1, '--to': 1 } },
  new: { words: 0, flags: { '--title': 1, '--body-file': 1, '--milestone': 1, '--label': 1, '--priority': 1, '--field': 1, '--from': 1, '--status': 1 } },
  ready: { words: 2, flags: { '--local': 0, '--attempts': 1, '--interval': 1 } }, handoff: { words: 2, flags: { '--stall': 1, '--grace': 1, '--interval': 1, '--refs': 0 } },
  merge: { words: 1, flags: { '--stack': 0, '--stall': 1, '--grace': 1, '--interval': 1, '--max-minutes': 1 } }, 'stack-sync': { words: 1 } };
function refusesArguments() {
  const { words, flags = {} } = writeArgs[command], args = process.argv.slice(3);
  let given = 0;
  for (let index = 0; index < args.length; index++) {
    if (Object.hasOwn(flags, args[index])) index += flags[args[index]];
    else if (/^-./.test(args[index])) return true; // a lone "-" is a file name (`body ISSUE - BASE`), not a flag
    else given++;
  }
  return given > words - (args.includes('--local') ? 1 : 0);
}
if (Object.hasOwn(writeArgs, command) && refusesArguments()) {
  console.error(usage);
  process.exit(2);
}
if (['reviews', 'wait', 'handoff', 'merge', 'done'].includes(command) && !(Number.isFinite(projectGrace) && projectGrace >= 0)) {
  console.error('reviewerGraceMinutes in .github/workflow-project.json must be a number of minutes, 0 or more (0 turns the grace off); omit the field for the default');
  process.exit(2);
}
if (['next', 'check', 'start'].includes(command) && !(Number.isFinite(staleHours) && staleHours >= 0)) {
  console.error('staleHours in .github/workflow-project.json must be a number of hours, 0 or more; omit the field for the default of 6');
  process.exit(2);
}
// Only numbers and plain names reach gh, so no argument can smuggle in options.
if (command === 'ready' && Number.isSafeInteger(number) && !/^[0-9a-f]{7,40}$/i.test(value ?? '')) {
  console.error(`ready needs a commit id of 7 to 40 characters (git rev-parse HEAD) or --local, not ${value ? `"${value}"` : 'nothing'}`);
  process.exit(2);
}
if (command === 'wait' && Number.isSafeInteger(number) && value !== '--merged' && headOption() !== undefined && !/^[0-9a-f]{7,40}$/i.test(headOption())) {
  console.error(`wait --head needs a commit id of 7 to 40 characters (git rev-parse HEAD), not ${headOption() ? `"${headOption()}"` : 'nothing'}`);
  process.exit(2);
}
if (!commands[command] || (!['next', 'sweep', 'new', 'quota-wait'].includes(command) && !Number.isSafeInteger(number))
  // Field names and options travel as GraphQL variables, so any printable text works (Größe, Area/Team, P0: urgent).
  || (command === 'field' && !(process.argv.length > 5 && process.argv.slice(4).filter(arg => arg !== '--spec-review').every(text => /^[^\p{Cc}-][^\p{Cc}]*$/u.test(text))))
  // A misspelled flag must not silently turn the session check off.
  || (command === 'next' && process.argv.length > 3 && !(process.argv.length === 5 && process.argv[3] === '--session' && /^\w[\w.-]*$/.test(process.argv[4])))
  || (command === 'check' && process.argv.length > 4 && !(process.argv.length === 6 && process.argv[4] === '--session' && /^\w[\w.-]*$/.test(process.argv[5])))
  || (command === 'start' && process.argv.includes('--session') && !/^\w[\w.-]*$/.test(sessionOption() ?? ''))
  || (['reviews', 'wait', 'handoff', 'merge'].includes(command) && !(stallOption() > 0 && graceOption() >= 0 && Number.isFinite(graceOption())))
  // sleep(NaN) would wait forever.
  || (['handoff', 'merge'].includes(command) && !(numberOption('--interval', 3) >= 0 && numberOption('--interval', 3) <= 60))
  // wait: a fixed pause between reads instead of the growing one (60 to 300 s).
  || (command === 'wait' && !(numberOption('--interval', 60) >= 0 && numberOption('--interval', 60) <= 300))
  // --head is the id of the pushed commit (git rev-parse HEAD, 7 to 40 characters), as for ready; a missing one would wait on a head that never matches.
  || (headOption() !== undefined && (command !== 'wait' || value === '--merged' || !/^[0-9a-f]{7,40}$/i.test(headOption())))
  // 0 = no limit; a missing or non-numeric value must not silently mean that.
  || (process.argv.includes('--max-minutes') && (!['wait', 'merge', 'quota-wait', 'done'].includes(command) ||!(numberOption('--max-minutes', 9) >= 0 && Number.isFinite(numberOption('--max-minutes', 9)))))
  || (['handoff', 'link'].includes(command) && (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1))
  || (command === 'ready' && (!/^[0-9a-f]{7,40}$/i.test(value ?? '') || !readyOptionsBounded()))
  || (command === 'body' && !(value && process.argv[5]))
  || (command === 'body-replace' && !(process.argv.length === 8 && value === '--from' && process.argv[6] === '--to' && process.argv[5] && process.argv[7]))
  || (['block', 'sub'].includes(command) && !validBlocker(value ?? ''))) {
  console.error(usage);
  process.exit(2);
}
// field and new report a failure as one "ERROR - reason" line: their output (verdicts, backlinks, confirmations)
// is held until the command succeeds, so no failed call shows a write or a check as confirmed. The other commands keep ERROR
// with "- reason" below it.
const oneLine = ['field', 'new'].includes(command), print = console.log, held = [];
if (oneLine) console.log = (...parts) => held.push(parts.join(' '));
try {
  await commands[command]();
  console.log = print;
  for (const line of held) print(line);
} catch (error) {
  console.log = print;
  // A failed read is never "no blockers" and never a finished review.
  if (!['start', 'done', 'check', 'reviews', 'wait', 'quota-wait', 'handoff', 'merge', 'stack-sync', 'ready', 'link', 'body', 'body-replace', 'field', 'new'].includes(command)) throw error;
  const message = String(error.stderr || error.message).trim();
  console.log(oneLine ? `ERROR - ${message.replace(/\s*\n\s*/g, ' ')}` : `${command === 'check' ? 'UNKNOWN' : 'ERROR'}\n- ${message}`);
  process.exitCode = 2;
} finally {
  // Waiting commands already print their quota with the verdict; all other commands need the same evidence, also on failure.
  const alreadyPrintedQuota = ['reviews', 'wait', 'quota-wait'].includes(command)
    || (process.exitCode === 4 && ['handoff', 'merge'].includes(command));
  if (quota && (process.exitCode === 2 || !alreadyPrintedQuota)) console.error(quotaLine());
}
