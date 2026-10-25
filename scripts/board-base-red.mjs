// `done`: the tests that are red on the PR base too (#1052): their issue is named or created, and the handoff lists them.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseRedLines, baseRedSection } from './base-red.mjs';
import { projectItem } from './board-common.mjs';
import { createOne } from './board-new.mjs';
import { git, graphql, issueName, issueOwner, number, project, projectDirectory, rest, restAll } from './board-context.mjs';

/** The Project field values and Priority of the issue `done` works on; a base-red issue starts with the same ones (Size, target release). */
function parentValues() {
  const { repository } = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
  issue(number:$number){projectItems(first:100){nodes{project{id} fieldValues(first:100){nodes{
    ...on ProjectV2ItemFieldSingleSelectValue{name field{...on ProjectV2FieldCommon{name}}}}}}}
  issueFieldValues(first:100){nodes{...on IssueFieldSingleSelectValue{name field{...on IssueFieldSingleSelect{name}}}}}}}}`, { owner: issueOwner, name: issueName, number });
  return [...projectItem(repository.issue)?.fieldValues.nodes ?? [], ...repository.issue.issueFieldValues.nodes].filter(entry => entry?.field?.name && entry.name)
    .map(entry => [entry.field.name, entry.name]);
}

/** The section for the handoff comment, or '' when no test was red on the base. Creates the missing issues (status Ready, milestone, labels and fields of the issue at hand). */
export function baseRedHandoff(names, base) {
  if (!names.length) return '';
  const issues = restAll(`repos/${project.repository}/issues`).filter(item => !item.pull_request);
  const lines = baseRedLines(names, issues, (className, tests) => {
    const parent = rest(`repos/${issueOwner}/${issueName}/issues/${number}`);
    const values = parentValues(), priority = values.find(([field]) => field === 'Priority')?.[1];
    const fields = values.filter(([field]) => !['Status', 'Priority'].includes(field));
    const bodyFile = resolve(projectDirectory, git('rev-parse', '--git-path', 'board-done-base-red.md'));
    writeFileSync(bodyFile, `${tests.map(name => `- \`${name}\``).join('\n')}\n\nDiese Tests scheitern schon auf \`${base}\`, ohne dass ein PR etwas geändert hat. Gefunden bei \`board.mjs done\` für #${number}: ${className} blockiert dort keine Übergabe, solange dieses Issue offen ist.\n`);
    const { created } = createOne({ title: `Test schon auf der Basis rot: ${className}`, bodyFile, milestone: parent.milestone?.title, priority: priority ?? 'High', status: 'Ready',
      labels: parent.labels.map(label => label.name).filter(name => name !== 'spec'), fields });
    return created.html_url;
  });
  return baseRedSection(base, lines);
}
