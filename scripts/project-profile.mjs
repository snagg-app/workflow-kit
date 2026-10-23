// What a project's .github/workflow-project.json says about its board statuses the language of the texts board.mjs writes and the kit skills it keeps.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asking, gitIn } from './git-tool.mjs';

const defaultStatuses = { backlog: 'Backlog', ready: 'Ready', inProgress: 'In progress', automatedReview: 'Automated review', humanReview: 'Human review', done: 'Done' };

/** The board's status names in workflow order. "statuses" renames any of them, for example {"humanReview": "QA"}. */
export function statusNames(project) {
  const renamed = project.statuses ?? {};
  const usage = `statuses in .github/workflow-project.json maps ${Object.keys(defaultStatuses).join(', ')} to distinct board status names; omit it for the defaults`;
  assert.ok(typeof renamed === 'object' && !Array.isArray(renamed)
    && Object.entries(renamed).every(([key, value]) => Object.hasOwn(defaultStatuses, key) && typeof value === 'string' && value.trim()), usage);
  const names = { ...defaultStatuses, ...renamed };
  assert.equal(new Set(Object.values(names)).size, Object.keys(names).length, usage);
  return names;
}

/** null when the board's status names (in board order) are the project's six; otherwise what differs and the "statuses" entry that maps it. */
export function statusMismatch(actual, project) {
  const wanted = Object.entries(statusNames(project));
  if (actual.length === wanted.length && wanted.every(([, name], i) => name === actual[i])) return null;
  const quoted = names => names.map(name => `"${name}"`).join(', ') || 'none';
  const missing = wanted.filter(([, name]) => !actual.includes(name)), extra = actual.filter(name => !wanted.some(([, expected]) => expected === name));
  // Same position, different name: the likely rename. A name that is merely out of order is not a rename.
  const renames = Object.fromEntries(wanted.flatMap(([key, name], i) => (!actual.includes(name) && extra.includes(actual[i]) ? [[key, actual[i]]] : [])));
  return `Existing board must have exactly the six workflow states in order: ${quoted(wanted.map(([, name]) => name))}. `
    + (missing.length || extra.length ? `Missing on the board: ${quoted(missing.map(([, name]) => name))}. Not expected: ${quoted(extra)}. ` : `The order differs: the board has ${quoted(actual)}. `)
    + (Object.keys(renames).length ? `Map the names in .github/workflow-project.json with "statuses", for example ${JSON.stringify({ statuses: renames })}. ` : 'Rename the board options or map them in .github/workflow-project.json with "statuses". ')
    + 'Migrate explicitly, preserving option IDs and cards.';
}

/**
 * The board `kit setup` copies for a new project: "boardTemplate" ({ owner, number }) of the project's file, else the board of the kit
 * repository (`kitProject`, the kit's own file). Existing boards are never copied.
 */
export function boardTemplate(project, kitProject) {
  const template = project.boardTemplate ?? kitProject;
  assert.ok(typeof template?.owner === 'string' && /^[A-Za-z0-9_.-]+$/.test(template.owner) && Number.isInteger(template.number) && template.number > 0,
    'boardTemplate in .github/workflow-project.json must be {"owner": "ORG", "number": 5}; omit it to copy the board of the kit repository');
  return { owner: template.owner, number: template.number };
}

const defaultLabels = [['ci', '1d76db'], ['documentation', '0075ca'], ['testing', '5319e7'], ['security', 'b60205'], ['dependencies', '0366d6'], ['needs-human-input', 'd93f0b'], ['spec', 'c5def5']]
  .map(([name, color]) => ({ name, color }));

/** The labels `kit setup` creates when missing: "labels" ([{ name, color }]) of the project's file, else the seven defaults. */
export function projectLabels(project) {
  const labels = project.labels ?? defaultLabels;
  assert.ok(Array.isArray(labels) && labels.every(label => typeof label?.name === 'string' && label.name.trim() && /^[0-9a-fA-F]{6}$/.test(label.color)),
    'labels in .github/workflow-project.json must be a list of {"name": "ci", "color": "1d76db"} (six hex digits); omit it for the default labels');
  return labels;
}

const texts = {
  en: {
    handoff: 'Handoff',
    claimed: 'Claimed.',
    base: 'Base',
    feedback: 'Feedback',
    waitsUntil: 'Waits until',
    decision: 'Decision',
    resultHint: '<result in one sentence>',
    noFindings: 'No findings',
    hooksChanged: 'Hooks changed since session start: restart the session',
    nodeOld: (needed, found) => `Node ${needed} or newer is needed for the Workflow Kit hooks (found ${found}); Ponytail, Impeccable and the kit check are off until Node is updated.`,
    hooksOff: (name, command) => `${name} hooks are OFF. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run ${command} (maintainer pre-authorized, writes no trust).`,
    selfReview: 'Self-review',
    delivered: (pr, base) => `Delivered with #${pr} in \`${base}\`. The release PR to \`main\` publishes the version.`,
    conflict: (url, statuses) => `PR ${url} conflicts with its base, but an issue in ${statuses.humanReview} must be mergeable. The issue goes back to ${statuses.automatedReview}. Resolve the conflict, then hand off again (\`board.mjs done\`).`,
  },
  de: {
    handoff: 'Übergabe',
    claimed: 'Beansprucht.',
    base: 'Basis',
    feedback: 'Rückmeldungen',
    waitsUntil: 'Wartet bis',
    decision: 'Entscheidung',
    resultHint: '<Ergebnis in einem Satz>',
    noFindings: 'Keine Funde',
    hooksChanged: 'Hooks seit Session-Start geändert: Session neu starten',
    nodeOld: (needed, found) => `Für die Hooks des Workflow Kits braucht es Node ${needed} oder neuer (gefunden: ${found}); Ponytail, Impeccable und die Kit-Prüfung sind aus, bis Node aktualisiert ist.`,
    hooksOff: (name, command) => `Die ${name}-Hooks sind AUS. Sie installieren sich beim Session-Start im Hintergrund: Sag dem Nutzer, er soll die Session einmal neu starten und den Hooks vertrauen. Sind sie danach noch AUS, fehlt node im PATH oder die Installation ist fehlgeschlagen; dann ${command} ausführen (vom Maintainer vorab erlaubt, schreibt kein Vertrauen).`,
    selfReview: 'Selbstprüfung',
    delivered: (pr, base) => `Geliefert mit #${pr} in \`${base}\`. Der Release-PR nach \`main\` veröffentlicht die Version.`,
    conflict: (url, statuses) => `Der PR ${url} hat Konflikte mit seiner Basis, ein Issue in ${statuses.humanReview} muss aber mergebar sein. Das Issue geht zurück auf ${statuses.automatedReview}. Konflikt lösen, dann neu übergeben (\`board.mjs done\`).`,
  },
};

/** Headings and comments board.mjs writes into issues and PRs, in "language" ("en" when omitted). */
export function textsFor(project) {
  const language = project.language ?? 'en';
  assert.ok(Object.hasOwn(texts, language), `language in .github/workflow-project.json must be one of ${Object.keys(texts).join(', ')}; omit it for "en"`);
  return texts[language];
}

/** The profile as GitHub has it on `ref` (the repository's default branch without one): the single read of a profile at a branch or commit. `rest` is the github adapter's. */
export function readProfileAt(rest, repository, ref) {
  const file = rest(`repos/${repository}/contents/.github/workflow-project.json${ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`}`);
  assert.equal(file?.encoding, 'base64', `.github/workflow-project.json of ${repository}${ref === undefined ? '' : ` on ${ref}`} is unreadable`);
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
}

/** The profile of a project directory ({} without a readable file). */
export function readProfile(root) {
  try { return JSON.parse(readFileSync(join(root, '.github/workflow-project.json'), 'utf8')); } catch { return {}; }
}

export const languages = Object.keys(texts);

/** One text in every language, for readers that accept what any language wrote (the claim's "Basis:" line, "Wartet bis:"). */
export const textInEveryLanguage = key => [...new Set(Object.values(texts).map(table => table[key]))];

/** The skills every project gets without a choice. Why these: docs/skill-core.md. */
export const coreSkills = ['spec-review', 'find-skills', 'pr', 'code-review', 'ponytail', 'ponytail-review', 'grilling', 'writing-for-agents', 'codebase-design', 'to-tickets'];

/**
 * The kit skills the project keeps, from "skills": a list of names, where "core" stands for the core set;
 * "all" keeps every kit skill (null). Omitted means the core set.
 */
export function activeSkills(project) {
  if (project.skills === undefined) return coreSkills;
  if (project.skills === 'all') return null;
  assert.ok(Array.isArray(project.skills) && project.skills.every(name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)),
    'skills in .github/workflow-project.json must be "all" or a list of kit skill names, for example ["core", "tdd"]; omit it to keep the core skills');
  return project.skills.flatMap(name => name === 'core' ? coreSkills : [name]);
}

const uiDependencies = ['react', 'react-dom', 'react-native', 'expo', 'vue', 'svelte', 'solid-js', 'preact', 'lit', '@angular/core', 'next', 'astro'];
const uiFile = /\.(?:tsx|jsx|vue|svelte|astro)$/;

/**
 * Whether the project has UI files: a component file (tracked or new, not ignored) or a UI dependency in any package.json.
 * shortcut: names the common frameworks only; when it guesses wrong, set "impeccable" to true or false in the profile.
 */
export function hasUi(root, git) {
  const listed = asking(git)(root, 'ls-files', '--cached', '--others', '--exclude-standard');
  const files = listed.ok ? listed.out.split('\n').filter(Boolean) : [];
  if (files.some(file => uiFile.test(file))) return true;
  return files.filter(file => /(?:^|\/)package\.json$/.test(file)).some(file => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
      return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(list => list && uiDependencies.some(name => Object.hasOwn(list, name)));
    } catch { return false; }
  });
}

/** The optional kit functions of a project: "impeccable" (true, false or "auto", the default: on with UI files) and "ponytail" (true by default, or false). */
export function projectFeatures(root, git = gitIn({}, root)) {
  const { impeccable = 'auto', ponytail = true } = readProfile(root);
  assert.ok([true, false, 'auto'].includes(impeccable), 'impeccable in .github/workflow-project.json must be true, false or "auto"; omit it for "auto" (on when the project has UI files)');
  assert.ok(typeof ponytail === 'boolean', 'ponytail in .github/workflow-project.json must be true or false; omit it for true');
  return { impeccable: impeccable === 'auto' ? hasUi(root, git) : impeccable, ponytail };
}
