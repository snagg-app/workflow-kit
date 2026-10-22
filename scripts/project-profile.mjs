// What a project's .github/workflow-project.json says about its board statuses the language of the texts board.mjs writes and the kit skills it keeps.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const texts = {
  en: {
    handoff: 'Handoff',
    selfReview: 'Self-review',
    delivered: (pr, base) => `Delivered with #${pr} in \`${base}\`. The release PR to \`main\` publishes the version.`,
    conflict: (url, statuses) => `PR ${url} conflicts with its base, but an issue in ${statuses.humanReview} must be mergeable. The issue goes back to ${statuses.automatedReview}. Resolve the conflict, then hand off again (\`board.mjs done\`).`,
  },
  de: {
    handoff: 'Übergabe',
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
export function hasUi(root) {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
  const files = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : [];
  if (files.some(file => uiFile.test(file))) return true;
  return files.filter(file => /(?:^|\/)package\.json$/.test(file)).some(file => {
    try {
      const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
      return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(list => list && uiDependencies.some(name => Object.hasOwn(list, name)));
    } catch { return false; }
  });
}

/** The optional kit functions of a project: "impeccable" (true, false or "auto", the default: on with UI files) and "ponytail" (true by default, or false). */
export function projectFeatures(root) {
  let project = {};
  try { project = JSON.parse(readFileSync(join(root, '.github/workflow-project.json'), 'utf8')); } catch { /* no profile: the defaults */ }
  const { impeccable = 'auto', ponytail = true } = project;
  assert.ok([true, false, 'auto'].includes(impeccable), 'impeccable in .github/workflow-project.json must be true, false or "auto"; omit it for "auto" (on when the project has UI files)');
  assert.ok(typeof ponytail === 'boolean', 'ponytail in .github/workflow-project.json must be true or false; omit it for true');
  return { impeccable: impeccable === 'auto' ? hasUi(root) : impeccable, ponytail };
}
