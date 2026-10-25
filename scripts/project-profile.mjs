// What a project's .github/workflow-project.json says (board statuses, the language of the texts board.mjs writes, the kit skills it keeps, review settings),
// read and checked in one place: readProfile (disk) and readProfileAt (a Git ref) are the only readers of the file.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asking, gitIn } from './git-tool.mjs';
import { featureProviders } from './provider-list.mjs';

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
    hooksChanged: 'Hooks changed since session start: restart the session',
    nodeOld: (needed, found) => `Node ${needed} or newer is needed for the Workflow Kit hooks (found ${found}); Ponytail, Impeccable and the kit check are off until Node is updated.`,
    hooksOff: (name, command) => `${name} hooks are OFF. They install themselves in the background at session start: tell the user to restart the session once and trust the hooks. If they are still OFF after that, node is missing from PATH or the install failed; then run ${command} (maintainer pre-authorized, writes no trust).`,
    selfReview: 'Self-review',
    delivered: (pr, base) => `Delivered with #${pr} in \`${base}\`. The release PR to \`main\` publishes the version.`,
    closedByMerge: (layer, trunk) => `Closed by \`board.mjs merge --stack\`: PR #${layer} is merged into ${trunk}, GitHub did not close the issue itself.`,
    noHandoff: (head, pr, number) => `no handoff comment for head ${head} on PR #${pr}: write FILE (<result in one sentence>, then "### Retro" with one list line per finding, or "- No findings"; README: Handoff comment) and run board.mjs done ${number} FILE`,
    reviewNeedsPr: status => `${status} needs the PR number: field ISSUE Status "${status}" PR [OTHER_ISSUE...]`,
    reviewNeedsLinks: status => `${status} requires PR [OTHER_ISSUE...]; post and read back every issue backlink first.`,
    kitBehind: (behind, name) => `Checkout is ${behind} commit(s) behind ${name} (as of the last fetch) and has no commits of its own but local changes, so it was not fast-forwarded and its rules, skills and board commands may be outdated. Nothing was fetched: commit or stash the changes, run git fetch, then git merge --ff-only ${name}; skills load at session start, so restart after updating.`,
    kitNotMain: (kit, branch) => `The shared Workflow Kit checkout ${kit} is ${branch ? `on branch ${branch}` : 'on a fixed revision'}, not on main, so it was not updated. When you are done with it: git -C ${kit} switch main`,
    kitDirty: kit => `The shared Workflow Kit checkout ${kit} has local changes or unpublished commits, so it was not updated. Kit work belongs in its own worktree of the kit repository: resolve them in ${kit}.`,
    kitLocked: (lock, pid, age) => `Another run holds the kit update lock ${lock} (PID ${pid}, ${age} s old). Running start again helps once it is done; a lock of a dead run is removed by itself, a stuck one after 10 minutes.`,
    kitLeftoverRemoved: name => `Removed the leftover git lock ${name} in the shared Workflow Kit checkout (an earlier update was aborted) and updated again.`,
    kitNotUpdated: kit => `The shared Workflow Kit checkout ${kit} could not be updated (offline or diverged?). Try: git -C ${kit} pull --ff-only && git -C ${kit} submodule update --init`,
    kitFolder: (root, init) => `${root}: .vendor/workflow-kit is a folder or submodule, not a link to the shared kit. Delete it (git rm -f for a submodule), then: node ${init} --existing --cwd ${root}`,
    kitMissing: (root, kit) => `${root}: the shared Workflow Kit checkout ${kit} is missing or incomplete. Clone it: git clone https://github.com/snagg-app/workflow-kit.git ${kit}`,
    kitLinkFailed: (root, kit, why) => `${root}: could not link .vendor/workflow-kit to ${kit} (${why}).`,
    kitNoGit: dir => `${dir}: Workflow Kit not checked: git did not find the project repository (is git on PATH?).`,
    modulesMissing: setup => `node_modules is missing in this worktree although package.json lists dependencies, so Node may resolve modules from a parent checkout. Nothing was installed. Fix: run \`${setup}\` in this worktree.`,
    conflict: (url, statuses, head) => `PR ${url} (head ${head}) conflicts with its base, but an issue in ${statuses.humanReview} must be mergeable. The issue goes back to ${statuses.automatedReview}. Resolve the conflict, then hand off again (\`board.mjs done\`).`,
  },
  de: {
    handoff: 'Übergabe',
    claimed: 'Beansprucht.',
    base: 'Basis',
    feedback: 'Rückmeldungen',
    waitsUntil: 'Wartet bis',
    decision: 'Entscheidung',
    hooksChanged: 'Hooks seit Session-Start geändert: Session neu starten',
    nodeOld: (needed, found) => `Für die Hooks des Workflow Kits braucht es Node ${needed} oder neuer (gefunden: ${found}); Ponytail, Impeccable und die Kit-Prüfung sind aus, bis Node aktualisiert ist.`,
    hooksOff: (name, command) => `Die ${name}-Hooks sind AUS. Sie installieren sich beim Session-Start im Hintergrund: Sag dem Nutzer, er soll die Session einmal neu starten und den Hooks vertrauen. Sind sie danach noch AUS, fehlt node im PATH oder die Installation ist fehlgeschlagen; dann ${command} ausführen (vom Maintainer vorab erlaubt, schreibt kein Vertrauen).`,
    selfReview: 'Selbstprüfung',
    delivered: (pr, base) => `Geliefert mit #${pr} in \`${base}\`. Der Release-PR nach \`main\` veröffentlicht die Version.`,
    closedByMerge: (layer, trunk) => `Geschlossen von \`board.mjs merge --stack\`: PR #${layer} ist in ${trunk} gemergt, GitHub hat das Issue nicht selbst geschlossen.`,
    noHandoff: (head, pr, number) => `kein Übergabe-Kommentar für den Stand ${head} im PR #${pr}: FILE schreiben (<Ergebnis in einem Satz>, dann "### Retro" mit je einer Listenzeile pro Fund oder "- Keine Funde"; README: Handoff comment) und board.mjs done ${number} FILE ausführen`,
    reviewNeedsPr: status => `${status} braucht die PR-Nummer: field ISSUE Status "${status}" PR [OTHER_ISSUE...]`,
    reviewNeedsLinks: status => `${status} braucht PR [OTHER_ISSUE...]; zuerst jeden Issue-Rückverweis posten und zurücklesen.`,
    kitBehind: (behind, name) => `Der Checkout liegt ${behind} Commit(s) hinter ${name} (Stand des letzten Fetch) und hat keine eigenen Commits, aber lokale Änderungen. Er wurde deshalb nicht vorgespult, Regeln, Skills und Board-Befehle können veraltet sein. Es wurde nichts geholt: Änderungen committen oder stashen, git fetch ausführen, dann git merge --ff-only ${name}; Skills laden beim Session-Start, danach neu starten.`,
    kitNotMain: (kit, branch) => `Der gemeinsame Workflow-Kit-Checkout ${kit} steht ${branch ? `auf dem Branch ${branch}` : 'auf einem festen Stand'}, nicht auf main, und wurde deshalb nicht aktualisiert. Danach: git -C ${kit} switch main`,
    kitDirty: kit => `Der gemeinsame Workflow-Kit-Checkout ${kit} hat lokale Änderungen oder unveröffentlichte Commits und wurde deshalb nicht aktualisiert. Kit-Arbeit gehört in einen eigenen Worktree des Kit-Repositorys: in ${kit} auflösen.`,
    kitLocked: (lock, pid, age) => `Ein anderer Lauf hält die Kit-Update-Sperre ${lock} (PID ${pid}, ${age} s alt). Start erneut aufrufen hilft, sobald er fertig ist; die Sperre eines toten Laufs verschwindet von selbst, eine hängende nach 10 Minuten.`,
    kitLeftoverRemoved: name => `Die übrig gebliebene git-Sperre ${name} im gemeinsamen Workflow-Kit-Checkout (ein früheres Update wurde abgebrochen) wurde entfernt und das Update erneut ausgeführt.`,
    kitNotUpdated: kit => `Der gemeinsame Workflow-Kit-Checkout ${kit} ließ sich nicht aktualisieren (offline oder auseinandergelaufen?). Versuch: git -C ${kit} pull --ff-only && git -C ${kit} submodule update --init`,
    kitFolder: (root, init) => `${root}: .vendor/workflow-kit ist ein Ordner oder Submodul, keine Verknüpfung zum gemeinsamen Kit. Löschen (bei einem Submodul git rm -f), dann: node ${init} --existing --cwd ${root}`,
    kitMissing: (root, kit) => `${root}: der gemeinsame Workflow-Kit-Checkout ${kit} fehlt oder ist unvollständig. Klonen: git clone https://github.com/snagg-app/workflow-kit.git ${kit}`,
    kitLinkFailed: (root, kit, why) => `${root}: .vendor/workflow-kit ließ sich nicht mit ${kit} verknüpfen (${why}).`,
    kitNoGit: dir => `${dir}: Workflow Kit nicht geprüft: git hat das Projekt-Repository nicht gefunden (ist git im PATH?).`,
    modulesMissing: setup => `node_modules fehlt in diesem Worktree, obwohl package.json Abhängigkeiten nennt; Node findet Module womöglich im übergeordneten Checkout. Es wurde nichts installiert. Beheben: in diesem Worktree \`${setup}\` ausführen.`,
    conflict: (url, statuses, head) => `Der PR ${url} (Stand ${head}) hat Konflikte mit seiner Basis, ein Issue in ${statuses.humanReview} muss aber mergebar sein. Das Issue geht zurück auf ${statuses.automatedReview}. Konflikt lösen, dann neu übergeben (\`board.mjs done\`).`,
  },
};

/** Headings and comments board.mjs writes into issues and PRs, in "language" ("en" when omitted). */
export function textsFor(project) {
  const language = project.language ?? 'en';
  assert.ok(Object.hasOwn(texts, language), `language in .github/workflow-project.json must be one of ${Object.keys(texts).join(', ')}; omit it for "en"`);
  return texts[language];
}

const profileFile = '.github/workflow-project.json';
// Lists of non-empty strings: the field and what its entries are.
const lists = {
  optionalReviewers: 'bot logins or app slugs', updateBranchChecks: 'check names', ignoredChecks: 'check names', awaitApps: 'app slugs', selfReview: 'check names', push: 'shell commands',
  requiredFields: 'field names', worktreeVolumePrefixes: 'volume name prefixes', worktreeVolumeProtect: 'volume name parts',
};
const numbers = { reviewerGraceMinutes: [3, 'a number of minutes, 0 or more (0 turns the grace off)'], staleHours: [6, 'a number of hours, 0 or more'] };

// Keys the kit reads besides the checked fields above: the board binding, "start" and "baseBranch" (board-common.mjs), "boardTemplate", "labels", "statuses", "skills", "language".
const otherKeys = ['repository', 'owner', 'number', 'id', 'url', 'start', 'baseBranch', 'boardTemplate', 'labels', 'statuses', 'skills', 'language'];

/** Edit distance of two short names (a typo is one or two edits). */
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Refuses a top-level key the kit does not read: it would be ignored silently, a typo like "doneBaseMerges" included. */
function assertKnownKeys(raw, where) {
  const known = [...new Set([...otherKeys, ...Object.keys(lists), ...Object.keys(numbers), 'specLabel', 'doneBaseMerge', 'setup', ...featureProviders().map(({ name }) => name)])];
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    const near = known.map(name => [name, distance(key.toLowerCase(), name.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
    assert.fail(`Unknown key "${key}" in ${where}${near[1] <= 3 ? `; did you mean "${near[0]}"?` : ''} Known keys: ${known.join(', ')}`);
  }
}

/**
 * The one check of a profile: parses the text, checks every known field once and returns the view: the file's fields with the defaults filled in
 * (`.raw` is the file as written, for a writer that must not copy defaults into it). `where` names the file in the message of a broken one.
 */
export function parseProfile(source, where = profileFile) {
  let raw;
  try { raw = JSON.parse(source); } catch (error) { throw new Error(`${where} is not valid JSON: ${error.message}`); }
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), `${where} must be a JSON object`);
  assertKnownKeys(raw, where);
  const view = { ...raw, statuses: statusNames(raw), language: raw.language ?? 'en', labels: projectLabels(raw) };
  textsFor(view);
  activeSkills(raw);
  if (raw.boardTemplate !== undefined) boardTemplate(raw);
  for (const [key, [fallback, what]] of Object.entries(numbers)) {
    view[key] = raw[key] === undefined ? fallback : raw[key];
    assert.ok(Number.isFinite(view[key]) && view[key] >= 0, `${key} in ${profileFile} must be ${what}; omit it for ${fallback}`);
  }
  for (const [key, what] of Object.entries(lists)) {
    view[key] = raw[key] === undefined ? [] : raw[key];
    assert.ok(Array.isArray(view[key]) && view[key].every(name => typeof name === 'string' && name.trim()), `${key} in ${profileFile} must be a list of ${what}; omit it for none`);
  }
  view.specLabel = raw.specLabel === undefined ? 'spec' : raw.specLabel;
  assert.ok(typeof view.specLabel === 'string' && view.specLabel.trim(), `specLabel in ${profileFile} must be a label name; omit it for "spec"`);
  view.doneBaseMerge = raw.doneBaseMerge === undefined ? 'always' : raw.doneBaseMerge;
  assert.ok(['always', 'overlap'].includes(view.doneBaseMerge), `doneBaseMerge in ${profileFile} must be "always" or "overlap"; omit it for "always"`);
  view.setup = raw.setup === undefined ? '' : raw.setup;
  assert.ok(typeof view.setup === 'string', `setup in ${profileFile} must be a shell command; omit it for none`);
  for (const { name, feature } of featureProviders()) {
    view[name] = raw[name] === undefined ? feature.default : raw[name];
    assert.ok(typeof view[name] === 'boolean' || (feature.auto && view[name] === 'auto'),
      `${name} in ${profileFile} must be ${feature.auto ? 'true, false or "auto"' : 'true or false'}; omit it for ${JSON.stringify(feature.default)}${feature.hint ?? ''}`);
  }
  return Object.defineProperty(view, 'raw', { value: raw });
}

/** The profile as GitHub has it on `ref` (the repository's default branch without one), checked. `rest` is the github adapter's. */
export function readProfileAt(rest, repository, ref) {
  const where = `${profileFile} of ${repository}${ref === undefined ? '' : ` on ${ref}`}`;
  const file = rest(`repos/${repository}/contents/${profileFile}${ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`}`);
  assert.equal(file?.encoding, 'base64', `${where} is unreadable`);
  return parseProfile(Buffer.from(file.content, 'base64').toString('utf8'), where);
}

/** The profile of a project directory, checked; without a file the defaults. The single read of a profile on disk. */
export function readProfile(root) {
  const file = join(root, profileFile);
  return parseProfile(existsSync(file) ? readFileSync(file, 'utf8').replace(/^﻿/, '') : '{}'); // BOM from Windows PowerShell 5.1
}

/** The profile of a project directory for readers that must not fail: a broken one reads as {} (English texts, no setup command); reporting it is board.mjs's job. The single fallback. */
export function readProfileLenient(root) {
  try { return readProfile(root); } catch { return {}; }
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

/** The optional kit functions of a project, one switch per provider with a `feature` (provider-list.mjs): true or false, or "auto" where the provider can tell (Impeccable: on with UI files). */
export function projectFeatures(root, git = gitIn({}, root), profile = readProfile(root)) {
  return Object.fromEntries(featureProviders().map(({ name, feature }) => [name, profile[name] === 'auto' ? feature.auto(root, asking(git)) : profile[name]]));
}
