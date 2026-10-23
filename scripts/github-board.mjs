// Zweck: bindet ein Projekt an sein GitHub-Board: kopiert oder prüft das Project, verknüpft das Repository, legt fehlende Labels an.
// Aufruf: import { setupBoard } (kit.mjs setup) oder `node scripts/setup-github.mjs OWNER/REPO [NUMMER]`. Jeder GitHub-Aufruf läuft über github.mjs.
// Vorlage und Labels stehen im Profil des Projekts ("boardTemplate", "labels"); ohne sie gelten das Board des Kits und die sieben Standard-Labels.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gitResultIn } from './git-tool.mjs';
import { boardTemplate, projectLabels, readProfile, statusMismatch } from './project-profile.mjs';
import { projectFile, writeProjectFile } from './write-guard.mjs';

const kitRoot = fileURLToPath(new URL('..', import.meta.url));

/** OWNER/REPO of the `origin` remote, or undefined when it is no GitHub remote. */
function originRepository(root) {
  const remote = gitResultIn()(root, 'remote', 'get-url', 'origin').stdout.trim();
  return /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
}

/**
 * Binds the project in `root` to its board. `repo` and `number` name the target by hand; without `repo` the `origin` remote decides and a
 * project that is already bound stays as it is: no network, no GraphQL quota (#730). Returns { status, note, text }; a failed check throws.
 */
export function setupBoard({ root, github, repo, number: requestedNumber, kitProject }) {
  const markerName = '.github/workflow-project.json', marker = join(root, markerName);
  const byHand = repo !== undefined;
  repo ??= originRepository(root);
  if (!repo) return { status: 1, stderr: 'no GitHub remote "origin"' };
  const saved = existsSync(marker) ? readProfile(root) : null;
  if (!byHand && saved?.repository?.toLowerCase() === repo.toLowerCase() && saved.number && saved.id)
    return { status: 0, note: `already bound to project #${saved.number}; run setup-github.mjs ${repo} to redo it` };
  if (!github.signedIn()) return { status: 1, stderr: 'gh is not signed in' };

  const [owner, name] = repo.split('/');
  projectFile(root, markerName); // refuses a path that leaves the checkout or a marker that is no plain file
  // GitHub names are case-insensitive: a remote written acme/app is the recorded acme/App.
  if (saved?.repository) assert.equal(saved.repository.toLowerCase(), repo.toLowerCase(), 'Recorded project belongs to another repository');
  const meta = github.viewRepository(repo);
  assert.ok(['ADMIN', 'MAINTAIN', 'WRITE'].includes(meta.viewerPermission), 'Repository write permission required');
  const number = requestedNumber ?? saved?.number;
  if (number) assert.match(String(number), /^\d+$/, 'Recorded project number must be numeric');
  const template = number ? undefined : boardTemplate(saved ?? {}, kitProject ?? readProfile(kitRoot));
  const project = number
    ? github.viewProject(number, owner)
    : github.copyProject(template.number, template.owner, owner, name);
  const saveProject = () => {
    // Keep project-owned settings such as "start"; only the board binding is rewritten.
    writeProjectFile(root, markerName, JSON.stringify({ ...saved?.raw, repository: saved?.repository ?? repo, owner, number: project.number, id: project.id, url: project.url }, null, 2) + '\n');
  };
  // Retain newly copied boards on failure so retry cannot create duplicates.
  if (!number) saveProject();
  const fields = github.projectFields(project.number, owner);
  const status = fields.fields.find(f => f.name === 'Status');
  const mismatch = statusMismatch(status?.options?.map(o => o.name) ?? [], saved ?? {});
  assert.ok(!mismatch, mismatch);
  const priority = fields.fields.find(f => f.name === 'Priority');
  assert.ok(priority, 'Existing board lacks Priority; add a usable priority scale without replacing foreign fields');
  // Organization issue fields expose their choices on issueField rather than Project options.
  const priorityOptions = priority.options?.length ? priority.options : github.graphql(
    'query($id:ID!) { node(id:$id) { ... on ProjectV2SingleSelectField { issueField { ... on IssueFieldSingleSelect { options { name } } } } } }',
    { id: priority.id }).node?.issueField?.options;
  assert.ok(priorityOptions?.length >= 2, 'Priority needs a usable explicit scale; configure/verify its choices before completing setup');
  github.linkProject(project.number, owner, repo);
  const labels = new Set(github.labelNames(repo));
  for (const { name: label, color } of projectLabels(saved ?? {}))
    if (!labels.has(label)) github.createLabel(repo, label, color);
  saveProject();
  return {
    status: 0, note: `bound to project #${project.number}`,
    text: `Project linked: ${project.url}\nLabels configured; existing labels preserved.\n`
      + `Remaining account settings: enable only the chosen reviewers; configure Project Auto-add for repo:${repo} is:issue.\n`
      + 'Verify native automation, permissions and required checks in GitHub; configuration is not proof of an active integration.',
  };
}
