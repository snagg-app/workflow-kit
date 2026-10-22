// What a project's .github/workflow-project.json says about its board statuses the language of the texts board.mjs writes and the kit skills it keeps.
import assert from 'node:assert/strict';

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

/** The kit skills the project keeps, from "skills" (a list of names); null keeps all of them. */
export function activeSkills(project) {
  if (project.skills === undefined) return null;
  assert.ok(Array.isArray(project.skills) && project.skills.every(name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)),
    'skills in .github/workflow-project.json must be a list of kit skill names, for example ["tdd", "ponytail"]; omit it to keep all kit skills');
  return project.skills;
}
