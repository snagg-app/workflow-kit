import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { externalTool } from './checkout-root.mjs';
import { statusNames } from './project-profile.mjs';

const [repo, requestedNumber] = process.argv.slice(2);
// Only plain names and numbers reach gh: no argument can smuggle in options.
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || (requestedNumber !== undefined && !/^\d+$/.test(requestedNumber))) {
  console.error('Usage: node setup-github.mjs OWNER/REPO [PROJECT_NUMBER]');
  process.exit(2);
}
const [owner, name] = repo.split('/');
const root = realpathSync(process.cwd());
const outside = path => path !== root && !path.startsWith(root + sep);
const ghTool = externalTool('gh', root);
const gh = (...args) => execFileSync(ghTool.file, args, { encoding: 'utf8', env: ghTool.env }).trim();
const marker = resolve('.github/workflow-project.json');
const directory = dirname(marker);
const present = path => lstatSync(path, { throwIfNoEntry: false });
assert.ok(!present(directory) || !outside(realpathSync(directory)), 'Project directory leaves checkout');
assert.ok(!present(marker) || present(marker).isFile(), 'Project marker must be a regular file');
const saved = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
// GitHub names are case-insensitive: a remote written snagg-app/snagg is the recorded snagg-app/Snagg.
if (saved?.repository) assert.equal(saved.repository.toLowerCase(), repo.toLowerCase(), 'Recorded project belongs to another repository');
const meta = JSON.parse(gh('repo', 'view', repo, '--json', 'viewerPermission,url'));
assert.ok(['ADMIN', 'MAINTAIN', 'WRITE'].includes(meta.viewerPermission), 'Repository write permission required');
const number = requestedNumber ?? saved?.number;
if (number) assert.match(String(number), /^\d+$/, 'Recorded project number must be numeric');
const project = number
  ? JSON.parse(gh('project', 'view', String(number), '--owner', owner, '--format', 'json'))
  : JSON.parse(gh('project', 'copy', '5', '--source-owner', 'snagg-app', '--target-owner', owner, '--title', name, '--format', 'json'));
const saveProject = () => {
  mkdirSync(dirname(marker), { recursive: true });
  // Keep project-owned settings such as "start"; only the board binding is rewritten.
  writeFileSync(marker, JSON.stringify({ ...saved, repository: saved?.repository ?? repo, owner, number: project.number, id: project.id, url: project.url }, null, 2) + '\n');
};
// Retain newly copied boards on failure so retry cannot create duplicates.
if (!number) saveProject();
const fields = JSON.parse(gh('project', 'field-list', String(project.number), '--owner', owner, '--format', 'json', '--limit', '100'));
const status = fields.fields.find(f => f.name === 'Status');
assert.deepEqual(status?.options?.map(o => o.name),
  Object.values(statusNames(saved ?? {})),
  'Existing board must have exactly the six workflow states in order ("statuses" in .github/workflow-project.json renames them); migrate explicitly, preserving option IDs and cards');
const priority = fields.fields.find(f => f.name === 'Priority');
assert.ok(priority, 'Existing board lacks Priority; add a usable priority scale without replacing foreign fields');
// Organization issue fields expose their choices on issueField rather than Project options.
const priorityOptions = priority.options?.length ? priority.options : JSON.parse(gh('api', 'graphql',
  '-f', 'query=query($id:ID!) { node(id:$id) { ... on ProjectV2SingleSelectField { issueField { ... on IssueFieldSingleSelect { options { name } } } } } }',
  '-f', `id=${priority.id}`)).data?.node?.issueField?.options;
assert.ok(priorityOptions?.length >= 2, 'Priority needs a usable explicit scale; configure/verify its choices before completing setup');
gh('project', 'link', String(project.number), '--owner', owner, '--repo', repo);
const labels = new Set(JSON.parse(gh('api', `repos/${repo}/labels?per_page=100`, '--paginate', '--slurp')).flat().map(l => l.name));
for (const [label, color] of [['ci', '1d76db'], ['documentation', '0075ca'], ['testing', '5319e7'], ['security', 'b60205'], ['dependencies', '0366d6'], ['needs-human-input', 'd93f0b'], ['spec', 'c5def5']])
  if (!labels.has(label)) gh('label', 'create', label, '--repo', repo, '--color', color);
saveProject();
console.log(`Project linked: ${project.url}\nLabels configured; existing labels preserved.\n`
  + `Remaining account settings: enable only the chosen reviewers; configure Project Auto-add for repo:${repo} is:issue.\n`
  + 'Verify native automation, permissions and required checks in GitHub; configuration is not proof of an active integration.');
