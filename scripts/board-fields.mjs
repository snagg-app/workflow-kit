// Project fields: reading the options, guarded writes and `field`.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import assert from 'node:assert/strict';

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createFields(env) {
  const { command, decisionWait, github, graphql, isSpec, issueName, issueOwner, issueProject, number, projectItem, readIssue, restAll, specRefusal, state, statusName, statuses } = env;
  const { check, mayStart, verifyBacklinks, waitReasons } = env.later;

  /** Specs are untouched outside a human-invoked spec-review; re-read children immediately before Human review. */
  function guardSpecStatus(issue, { fieldName, option }) {
    if (fieldName !== 'Status' || !isSpec(issue)) return;
    assert.ok(option.name !== statuses.done, specRefusal(issue.number, 'Status Done is refused'));
    assert.ok(command === 'field' && process.argv.includes('--spec-review'), specRefusal(issue.number, 'only a human-invoked spec-review changes its status; field requires --spec-review'));
    if (option.name === statuses.humanReview) {
      const children = restAll(`repos/${issueProject.repository}/issues/${issue.number}/sub_issues`);
      assert.ok(children.every(child => Number.isSafeInteger(child?.number) && ['open', 'closed'].includes(child.state)), 'Spec sub-issues are unreadable');
      const open = children.filter(child => child.state === 'open');
      assert.ok(!open.length, specRefusal(issue.number, `Human review is refused: open sub-issues ${open.map(child => `#${child.number}`).join(', ')}`));
    }
  }

  /** A single-select Project field with its options in configured order. The definitions are read once per run, however many fields are looked up. */
  let projectFields, fieldsCached = false, fieldsRefreshed = false; // refreshed: ids resolved before it may be stale
  // Field and option ids change rarely: kept in the clone's Git directory (shared by its worktrees) and read again only when a name
  // or option is missing from them or a write with them fails (writeOption). One read costs a point; every run used to pay it.
  function dropFieldsCache() {
    fieldsRefreshed = true;
    projectFields = undefined;
    fieldsCached = false;
    github.dropFieldsCache();
  }

  const loadFields = () => github.loadFields(issueProject.id);
  function selectField(fieldName, optionName) {
    if (!projectFields) ({ fields: projectFields, cached: fieldsCached } = loadFields());
    const known = () => {
      const found = projectFields.find(candidate => candidate.name === fieldName);
      const names = [...found?.options ?? [], ...found?.issueField?.options ?? []].map(choice => String(choice.name).toLowerCase());
      return found && (optionName === undefined || names.includes(String(optionName).toLowerCase())
        || (fieldName === 'Status' && names.some(choice => statusName(choice).toLowerCase() === statusName(optionName).toLowerCase())));
    };
    if (fieldsCached && !known()) { dropFieldsCache(); ({ fields: projectFields, cached: fieldsCached } = loadFields()); }
    const fields = projectFields;
    const field = fields.find(candidate => candidate.name === fieldName);
    assert.ok(field, `${issueProject.url} has no single-select ${fieldName} field; use one of: ${fields.map(candidate => candidate.name).join(', ')}`);
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
      input:{projectId:$project,contentId:$content}){item{id}}}`, { project: issueProject.id, content: issue.id }).addProjectV2ItemById.item.id;
    } catch (error) {
      if (!/already exists in this project/i.test(String(error.stderr ?? ''))) throw error;
      const id = projectItem(readIssue())?.id;
      assert.ok(id, `GitHub reports #${issue.number} as already on the Project, but its item is unreadable`);
      return id;
    }
  }

  /** Look up a field and option; nothing is printed or written. */
  function resolveOption(fieldName, optionName) {
    const { field, linked, choices } = selectField(fieldName, optionName);
    const normalized = name => String(fieldName === 'Status' ? statusName(name) : name).toLowerCase();
    const option = choices.find(choice => choice.name.toLowerCase() === String(optionName).toLowerCase())
      ?? choices.find(choice => normalized(choice.name) === normalized(optionName));
    assert.ok(option, `${fieldName}: "${optionName}" is not an option; use one of: ${choices.map(choice => choice.name).join(', ')}`);
    return { fieldName, field, linked, option };
  }

  /** Guards of a transition; a refusal throws. They print (backlinks), so run them only after every pair is valid. */
  function guardOption(issue, { fieldName, option }) {
    guardSpecStatus(issue, { fieldName, option });
    if (fieldName === 'Status' && option.name === statuses.ready) {
      // Ready contradicts an open decision wait: it stays Backlog until the line is removed (#514).
      const decisions = waitReasons(issue.body).blocked.filter(reason => reason.startsWith(decisionWait));
      if (decisions.length) throw new Error(`#${issue.number} cannot be Ready: ${decisions.join('; ')}`);
    }
    if (fieldName === 'Status' && option.name === statuses.inProgress) {
      // Assignment first, so a missing assignment is named even when the issue is also blocked.
      const viewer = issue.viewer; // read with the issue
      assert.ok(viewer?.login, 'Cannot verify the authenticated GitHub user');
      assert.ok(issue.assignees.nodes.some(assignee => assignee.login.toLowerCase() === viewer.login.toLowerCase()),
        `Assign yourself first: gh issue edit ${number} --repo ${issueProject.repository} --add-assignee "@me". Verify session ownership before assigning.`);
      // A refusal is an error like the others: its verdict lines become the one ERROR line instead of a second output format.
      const log = console.log, verdict = [];
      // An open issue in Done was reopened by a human (a merge closes it): it may leave Done, with a note (#510). A closed one stays blocked.
      const wasDone = issue.state === 'OPEN' && projectItem(issue)?.status?.name === statuses.done;
      const judged = wasDone ? { ...issue, projectItems: { nodes: issue.projectItems.nodes.map(item => item === projectItem(issue) ? { ...item, status: { name: statuses.ready } } : item) } } : issue;
      console.log = (...parts) => verdict.push(parts.join(' '));
      try { if (!mayStart(check(judged))) throw new Error(verdict.join('; ')); } finally { console.log = log; }
      if (wasDone) log(`note: #${issue.number} is open again and was Done; it moves to In progress`);
    }
    if (fieldName === 'Status' && statusName(option.name) === statuses.automatedReview) verifyBacklinks(issue);
  }

  function writeOption(issue, plan) {
    // After a refresh the ids of plans made before it are stale too (several fields in one call).
    if (fieldsRefreshed) plan = resolveOption(plan.fieldName, plan.option.name);
    try {
      return writeOptionOnce(issue, plan);
    } catch (error) {
      // Ids from the cache may be stale (a field or option was recreated): read them again and try once more.
      // Only a GraphQL refusal that names a field or option: a spec guard (assertion) or a quota pause is no stale id.
      if (!fieldsCached || error.code === 'ERR_ASSERTION' || !/could not resolve|global id|field|option/i.test(String(error.stderr ?? error.message))) throw error;
      dropFieldsCache();
      return writeOptionOnce(issue, resolveOption(plan.fieldName, plan.option.name));
    }
  }

  function writeOptionOnce(issue, { fieldName, field, linked, option }) {
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
        issue.projectItems.nodes.push({ id: item, project: { id: issueProject.id } });
      }
      graphql(`mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,
      itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`,
      { project: issueProject.id, item, field: field.id, option: option.id }, undefined, beforeSend);
    }
    return `${issueProject.repository}#${issue.number} ${fieldName}: ${option.name}`;
  }

  /** Write a selected field option; guarded delivery can reject the fresh issue before mutation. */
  function set(fieldName, optionName = state.value, beforeWrite) {
    // A guarded handoff rechecks current ownership/readiness after the potentially lengthy review reads; its fresh issue replaces this read.
    let issue = beforeWrite ? undefined : readIssue();
    const plan = resolveOption(fieldName, optionName);
    if (beforeWrite) {
      issue = beforeWrite();
      if (!issue) return;
    }
    guardOption(issue, plan);
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
    { owner: issueOwner, name: issueName, number });
    const values = [...projectItem(repository.issue)?.fieldValues.nodes ?? [], ...repository.issue.issueFieldValues.nodes];
    for (const { fieldName, option } of plans) {
      const stored = values.find(entry => entry?.field?.name === fieldName)?.name;
      assert.equal(stored, option.name, `Read-back of ${fieldName} shows ${stored ?? 'no value'}`);
    }
    return written;
  }

  return { dropFieldsCache, selectField, resolveOption, writeOption, set, planFields, setField };
}
