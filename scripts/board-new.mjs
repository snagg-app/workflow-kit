// `new`: creates issues with everything the workflow requires.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { result } from './board-result.mjs';
import { args, github, graphql, project, rest, restAll, specLabel, statuses, memory } from './board-context.mjs';
import { named } from './board-common.mjs';
import { dropFieldsCache, fieldWords, guardOption, planFields } from './board-fields.mjs';

/** What `board.mjs help` and the parser know about the command; `run` names the function this module returns. */
export const specs = [
  { name: 'new', run: 'create', writes: true, oneLine: true, doc: 'docs/board/new.md', rest: { usage: '[NAME VALUE ...]', kind: 'printable' },
    usage: 'new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--status S] [--field NAME=VALUE ...] [NAME VALUE ...] | new --from FILE',
    summary: 'Creates an issue with its required metadata in one call, or many with --from. Everything is checked first and read back. Extra fields: NAME VALUE or --field NAME=VALUE.',
    flags: { '--title': { value: 'T', help: 'Issue title (an open issue with that title is refused).' }, '--body-file': { value: 'FILE', help: 'File with the body.' }, '--milestone': { value: 'M', help: 'An open milestone.' },
      '--label': { value: 'L', many: true, help: 'An existing label, repeatable.' }, '--priority': { value: 'P', help: 'Priority option.' }, '--status': { value: 'S', help: 'Status option (default Backlog).' },
      '--field': { value: 'NAME=VALUE', kind: 'printable', many: true, help: 'Another Project field, repeatable (not Status or Priority).' },
      '--from': { value: 'FILE', help: 'A JSON list of 1 to 50 issues; takes no other option.' } },
    check: args => args.flag('--from') && (args.names().length > 1 || args.rest.length) ? 'new --from takes one FILE and no other option' : undefined },
];

/** The values of one `new` call; unknown or repeated flags were refused by the parser. The extra fields are `--field NAME=VALUE` and free `NAME VALUE` words alike. */
function newOptions() {
  const words = fieldWords();
  assert.ok(words.length % 2 === 0, 'new takes NAME VALUE pairs after its flags');
  const fields = Array.from({ length: words.length / 2 }, (_, index) => words.slice(index * 2, index * 2 + 2));
  return { title: args.value('--title'), bodyFile: args.value('--body-file'), milestone: args.value('--milestone'), priority: args.value('--priority'), status: args.value('--status'),
    fields, labels: args.values('--label') };
}

/**
 * One issue to create, every value checked and resolved before anything exists: body, Project fields (all of them against one read
 * of the field definitions), milestone and labels. `status` is the Status the command sets.
 */
const sameTitle = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
function planNew({ title, bodyFile, milestone, priority, labels: wanted, fields }, status = statuses.backlog) {
  for (const [what, text] of [['title', title], ['body file', bodyFile], ['milestone', milestone], ['priority', priority]]) assert.ok(text, `${what} is required`);
  assert.ok(wanted.length, 'at least one label is required');
  const text = readFileSync(bodyFile, 'utf8').replaceAll('\r\n', '\n').trimEnd();
  assert.ok(text, `${bodyFile} is empty`);
  assert.ok(!fields.some(([fieldName]) => ['status', 'priority'].includes(fieldName.toLowerCase())), 'Status and Priority are not field values (give the priority; the command sets Status)');
  const pairs = [['Status', status], ['Priority', priority], ...fields];
  for (const required of project.requiredFields) {
    assert.ok(pairs.some(([fieldName]) => fieldName.toLowerCase() === required.toLowerCase()), `the project requires ${required}: give a value for it`);
  }
  const plans = planFields(pairs);
  const statusPlan = plans.find(plan => plan.fieldName === 'Status');
  assert.ok(!wanted.some(label => label.toLowerCase() === specLabel.toLowerCase()) || statusPlan.option.name === statuses.backlog, `A new spec starts in ${statuses.backlog}; only a human-invoked spec-review changes its status`);
  // The same Status guards as `field`, judged on the issue as it is about to exist: its body and labels; no assignee or Project item yet.
  // Backlog has no guard of its own (a new spec's Backlog was allowed just above).
  if (statusPlan.option.name !== statuses.backlog) guardOption({ number: 'neu', body: text, state: 'OPEN', labels: { nodes: wanted.map(name => ({ name })), totalCount: wanted.length },
    assignees: { nodes: [] }, projectItems: { nodes: [] } }, statusPlan);
  // Open issues over REST, not the search index, which misses one created seconds ago by a parallel session (#618). PRs are listed too.
  memory.repositoryLists ??= { milestones: restAll(`repos/${project.repository}/milestones`), labels: restAll(`repos/${project.repository}/labels`),
    issues: restAll(`repos/${project.repository}/issues`).filter(item => !item.pull_request) };
  // shortcut: two sessions creating within the same second still both pass; GitHub has no conditional create.
  const same = memory.repositoryLists.issues.find(item => sameTitle(item.title, title));
  assert.ok(!same, `open issue ${same?.html_url} already has the title "${title}"; link it (board.mjs sub PARENT ${same?.number}) instead of creating it again`);
  const exact = (list, name, key) => list.find(item => item[key].toLowerCase() === name.toLowerCase());
  const found = exact(memory.repositoryLists.milestones, milestone, 'title');
  assert.ok(found, `${project.repository} has no open milestone "${milestone}"`);
  // The REST API would silently create an unknown label.
  // A repeated label (any casing) is one label: GitHub stores it once, and the read-back compares exactly.
  const labels = [...new Set(wanted.map(label => exact(memory.repositoryLists.labels, label, 'name')?.name ?? assert.fail(`${project.repository} has no label "${label}"`)))];
  return { title, text, plans, milestone: found, labels };
}

/** The REST call that creates the issue (no GraphQL point). A lost or unreadable answer does not prove that nothing was created. */
function post({ title, text, milestone, labels }) {
  try {
    const created = JSON.parse(github.write('POST', `repos/${project.repository}/issues`,
      { json: { title, body: text, milestone: milestone.number, labels } }));
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
  dropFieldsCache(); // the issue is created before its fields are written: a stale cached id would leave it half done
  if (args.flag('--from')) return createMany(args.value('--from'));
  const options = newOptions();
  // Status is set by the command: Backlog or --status (checked against the Project options by planFields).
  const plan = named('new', () => planNew(options, options.status ?? statuses.backlog));
  const created = post(plan);
  let step = 'reading it back';
  try {
    readBackIssue(created, plan);
    step = 'setting the Project fields';
    setFields([{ id: created.node_id, number: created.number, plans: plan.plans }]);
    return result('ok', 'NEW', { headline: newLine(created, plan), data: { issues: [created.html_url] } });
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
function createMany(file) {
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
    const [headline, ...notes] = made.map(({ created, plan }) => newLine(created, plan));
    return result('ok', 'NEW', { headline, notes, data: { issues: made.map(({ created }) => created.html_url) } });
  } catch (error) {
    throw new Error(`${known()}, but ${step} failed: ${String(error.stderr || error.message).trim()}; finish by hand with board.mjs field/status, do not create them again`, { cause: error });
  }
}

export { create };
