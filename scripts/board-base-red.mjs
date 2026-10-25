// `done`: the tests that are red on the PR base too (#1052): their issue is named or created, and the handoff lists them.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseRedLines, baseRedSection } from './base-red.mjs';
import { projectItem } from './board-common.mjs';
import { createOne } from './board-new.mjs';
import { git, graphql, issueName, issueOwner, number, project, projectDirectory, rest, restAll, texts } from './board-context.mjs';

/** The Project field values (name, option) of the issue `done` works on; a base-red issue starts with the same ones (Size, target release). */
function parentValues() {
  const { repository } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
  issue(number:$number){projectItems(first:100){nodes{project{id} fieldValues(first:100){nodes{
    ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}}}}}
  issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}}`, { owner: issueOwner, name: issueName, number });
  return [...projectItem(repository.issue)?.fieldValues.nodes ?? [], ...repository.issue.issueFieldValues.nodes].filter(entry => entry?.field?.name && entry.name)
    .map(entry => [entry.field.name, entry.name]);
}

/**
 * The section for the handoff comment, or '' when no test was red on the base. Creates the missing issues (status Ready; milestone, labels and
 * fields of the issue at hand, read once). An issue that cannot be created is named in the section; it never stops the handoff.
 */
export function baseRedHandoff(names, base) {
  if (!names.length) return '';
  // shortcut: the check for an open issue and its creation are not atomic; two parallel `done` runs for one head could both create it.
  const issues = restAll(`repos/${project.repository}/issues`).filter(item => !item.pull_request && item.number !== number);
  let parent;
  const lines = baseRedLines(names, issues, (className, tests) => {
    parent ??= { issue: rest(`repos/${issueOwner}/${issueName}/issues/${number}`), values: parentValues() };
    const bodyFile = resolve(projectDirectory, git('rev-parse', '--git-path', 'board-done-base-red.md'));
    writeFileSync(bodyFile, texts.baseRedBody(base, number, tests));
    const { created } = createOne({ title: texts.baseRedTitle(className), bodyFile, milestone: parent.issue.milestone?.title, status: 'Ready',
      priority: parent.values.find(([field]) => field === 'Priority')?.[1] ?? 'High', labels: parent.issue.labels.map(label => label.name).filter(name => name !== 'spec'),
      fields: parent.values.filter(([field]) => !['Status', 'Priority'].includes(field)) });
    return created.html_url;
  }, texts);
  return baseRedSection(base, lines, texts);
}
