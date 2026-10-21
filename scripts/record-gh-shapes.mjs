#!/usr/bin/env node
// Renews the recorded GitHub answers of the board tests (scripts/tests/gh-shapes/*.json) from real GitHub.
//   node scripts/record-gh-shapes.mjs [--repo OWNER/NAME] [--issue N]... [--pr N]...
// Read-only: only `query` documents are sent (a mutation is refused before it leaves), no REST call, nothing is written to GitHub.
// Pick issues and PRs that have comments, labels, sub-issues, checks and reviews: a field that is null or an empty list in the
// answer cannot be checked later. Several --issue/--pr are merged into one shape.
// Names, texts and numbers never reach the files: a string becomes "x" (an enum such as OPEN stays), a number 1, a list one merged element.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { merge } from './tests/gh-shapes.mjs';

const dir = new URL('./tests/gh-shapes/', import.meta.url);
/** The fields whose value is one of GitHub's fixed words; every other string is replaced. */
export const enumKeys = new Set(['state', 'stateReason', 'status', 'conclusion', 'mergeStateStatus', 'reviewDecision', 'event', '__typename']);

/** The answer without its data (see the top of this file). */
export function sanitize(value, key) {
  if (Array.isArray(value)) return value.length ? [value.map(item => sanitize(item, key)).reduce(merge)] : [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, sanitize(inner, name)]));
  if (typeof value === 'string') return enumKeys.has(key) ? value : 'x';
  return typeof value === 'number' ? 1 : value;
}

/** A query document passes; a mutation or subscription does not. */
export const isQuery = query => /^\s*query\b/.test(query);

function graphql(query, variables) {
  if (!isQuery(query)) throw new Error('Only queries are recorded; this one would write to GitHub');
  const args = ['api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([name, value]) => [typeof value === 'number' ? '-F' : '-f', `${name}=${value}`])];
  const answer = JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
  if (answer.errors) throw new Error(JSON.stringify(answer.errors));
  return answer.data;
}

function main() {
  const args = process.argv.slice(2), values = flag => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
  const project = JSON.parse(fs.readFileSync(new URL('../.github/workflow-project.json', import.meta.url), 'utf8'));
  const [owner, name] = (values('--repo')[0] ?? project.repository).split('/');
  const issues = values('--issue').map(Number), prs = values('--pr').map(Number);
  if (!issues.length || !prs.length) throw new Error('Name at least one --issue and one --pr to record');
  const ids = [];
  for (const probe of JSON.parse(fs.readFileSync(new URL('probes.json', dir), 'utf8'))) {
    const query = probe.query.join(' ').replaceAll('$IDS',JSON.stringify(ids));
    const runs = probe.per === 'issue' ? issues.map(number => ({ owner, name, number, branch: `/${number}-` }))
      : probe.per === 'pr' ? prs.map(number => ({ owner, name, number }))
        : [{ owner, name, q: `repo:${owner}/${name} is:issue is:open`, project: project.id }];
    let shape;
    for (const variables of runs) {
      const wanted = new Set(query.match(/\$(\w+)/g)?.map(variable => variable.slice(1)));
      const raw = graphql(query, Object.fromEntries(Object.entries(variables).filter(([key]) => wanted.has(key))));
      if (probe.per === 'issue') ids.push(raw.repository.issue.id, ...raw.repository.issue.projectItems.nodes.slice(0, 1).map(item => item.id));
      if (probe.per === 'pr') ids.push(raw.repository.pullRequest.id);
      shape = merge(shape, sanitize(raw));
    }
    fs.writeFileSync(new URL(`${probe.name}.json`, dir), `${JSON.stringify(shape, null, 1)}\n`);
    console.log(`recorded ${probe.name}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) main();
