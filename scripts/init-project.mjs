// Zweck: Kit-Verknüpfung, Kit-Hooks, .gitignore und .ignore (Suche) in das Projekt übernehmen; neue Projekte erhalten die Vorlagen.
// Aufruf: Bei Einrichtung oder Kit-Updates, aus dem gemeinsamen Kit-Checkout (--cwd PROJEKT); --existing lässt die Vorlagen weg.
// Nutzen: .vendor/workflow-kit zeigt auf den gemeinsamen Checkout; Kit-Handler werden an ihrer Kennung ersetzt; fremde Hooks und Einstellungen bleiben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { agents, entryFile, handlerId, projectAgents } from './agents.mjs';
import { hookSettings } from './hooks.mjs';
import { linkKit } from './kit-check.mjs';
import { ownSkills } from './provider-list.mjs';
import { languages, projectFeatures, readProfile } from './project-profile.mjs';
import { projectFile, writeProjectFile } from './write-guard.mjs';
import { isMain } from './is-main.mjs';

const kit = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const text = p => readFileSync(p, 'utf8').replace(/^﻿/, '').replaceAll('\r\n', '\n'); // Windows PowerShell 5.1 writes a BOM
// Every kit handler carries this id; the template files stay the only place that names it.
const ours = handler => handler.id === handlerId;

/** Configures the project at `root` (an existing project keeps its own files: no templates). Throws on a problem; prints what it did. */
export function initProject({ root, existing = false, log = console.log, profile = readProfile(root) }) {
  // The kit is the shared checkout; it configures itself or the project named by --cwd, never a project that contains the kit.
  assert.ok(root === kit || !(kit + sep).startsWith(root + sep), 'Run init-project from the shared kit checkout (a clone next to the project, not inside it): node <kit>/scripts/init-project.mjs --cwd <project>');
  const safe = file => projectFile(root, file);
  const write = (file, value) => writeProjectFile(root, file, value);

  /** Replace the kit's handlers in a hook file; foreign handlers, groups and settings stay. */
  function mergeHooks(name, template) {
    const target = safe(name);
    const current = existsSync(target) ? JSON.parse(text(target)) : {};
    const hooks = {};
    for (const [event, groups] of Object.entries(current.hooks ?? {})) {
      const kept = groups.flatMap(group => {
        if (!group.hooks) return ours(group) ? [] : [group];
        const handlers = group.hooks.filter(handler => !ours(handler));
        return handlers.length ? [{ ...group, hooks: handlers }] : [];
      });
      if (kept.length) hooks[event] = kept;
    }
    for (const [event, groups] of Object.entries(template.hooks)) hooks[event] = [...(hooks[event] ?? []), ...groups];
    // Template keys are schema metadata (version, description) and advance with the kit; other settings stay.
    const merged = { ...template, ...current, ...template, hooks };
    if (!template.description) delete merged.description; // the Impeccable description goes with its hooks
    write(name, JSON.stringify(merged, null, 2) + '\n');
  }

  // The same repair as the session-start hook; a folder or submodule in its place is the project's to delete.
  if (root !== kit) { const problem = linkKit(root, kit); assert.ok(!problem, problem); }

  const templates = readdirSync(join(kit, 'templates'), { recursive: true })
    .filter(file => lstatSync(join(kit, 'templates', file)).isFile()).map(file => file.split(sep).join('/'))
    // AGENTS.md marks a project as set up (kit.mjs); written last, an aborted first run still counts as new and the next run completes it.
    .sort((a, b) => (a === 'AGENTS.md') - (b === 'AGENTS.md'));
  const language = profile.language ?? 'en';
  for (const file of templates) {
    // templates/<language>/ holds the texts that differ by language; the project gets the one of its profile.
    const [first, ...rest] = file.split('/');
    const name = languages.includes(first) ? (first === language ? rest.join('/') : null) : file;
    // Templates start new projects; afterwards they belong to the project and are never overwritten.
    if (name && !existing && !existsSync(safe(name))) write(name, text(join(kit, 'templates', file)));
  }
  // The kit's handlers come from the agent table, the agents the project uses (detect) and its functions (profile).
  const features = projectFeatures(root, undefined, profile);
  const { names: hookNames, none: noAgentFound } = projectAgents(root, agent => agent.hooks);
  // The hook entries call this small copy of kit-entry.mjs, which finds or clones the kit when it is missing.
  write(entryFile, text(join(kit, 'scripts/kit-entry.mjs')));
  for (const name of hookNames) mergeHooks(agents[name].hooks.file, hookSettings(name, features));
  log(noAgentFound ? `No agent found in the project; hooks written for all: ${hookNames.join(', ')}.` : `Hooks written for the agents found: ${hookNames.join(', ')}.`);

  const patterns = ['/.vendor/workflow-kit', '/.workflow-kit/', '/.scratch/','/.impeccable/vendor/', '/.impeccable/setup-*/',
    ...Object.values(agents).map(agent => agent.localSettings).filter(Boolean), '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/',
    // Skills an agent reads through links stay out of Git; its own skills are committed.
    ...Object.values(agents).filter(agent => agent.linksShared).flatMap(({ skills }) => [`/${skills}/*`, ...ownSkills().map(skill => `!/${skills}/${skill}/`)])];
  // Existing text stays byte for byte (a trailing space can be significant, `name\ `; so are the line endings); missing lines are appended in the file's own line ending.
  const extend = (file, wanted) => {
    const current = existsSync(safe(file)) ? readFileSync(safe(file), 'utf8') : '';
    const have = current.split(/\r?\n/), missing = wanted.filter(line => line && !have.includes(line));
    if (!missing.length) return;
    const eol = current.includes('\r\n') ? '\r\n' : '\n';
    write(file, current + (current && !current.endsWith('\n') ? eol : '') + missing.join(eol) + eol);
  };
  extend('.gitignore', patterns);
  // .ignore is read by ripgrep, not git. Like .gitignore it grows by the template's missing lines, also with --existing.
  extend('.ignore', text(join(kit, 'templates/.ignore')).split('\n'));
  log('Project files configured. Generate and commit skills for this kit update; install and trust hooks explicitly.');
}

if (isMain(import.meta.url)) {
  enterCwd(); // `--cwd PROJECT_DIR` at any position
  const unknown = process.argv.slice(2).filter(argument => argument !== '--existing');
  if (unknown.length) { console.error(`Unknown argument: ${unknown.join(' ')}. Usage: init-project.mjs [--cwd PROJECT_DIR] [--existing]`); process.exit(2); }
  initProject({ root: projectRoot(), existing: process.argv.includes('--existing') });
}
