// Zweck: Kit-Verknüpfung, Kit-Hooks, .gitignore und .ignore (Suche) in das Projekt übernehmen; neue Projekte erhalten die Vorlagen.
// Aufruf: Bei Einrichtung oder Kit-Updates, aus dem gemeinsamen Kit-Checkout (--cwd PROJEKT); --existing lässt die Vorlagen weg.
// Nutzen: .vendor/workflow-kit zeigt auf den gemeinsamen Checkout; Kit-Handler werden an ihrer Kennung ersetzt; fremde Hooks und Einstellungen bleiben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { agents, hookSettings, ownSkills } from './agents.mjs';
import { linkKit } from './kit-check.mjs';
import { checkDirectory } from './provider-links.mjs';
import { projectFeatures } from './project-profile.mjs';

const kit = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
enterCwd(); // `--cwd PROJECT_DIR` as the first argument
const requestedRoot = projectRoot();
// The kit is the shared checkout; it configures itself or the project named by --cwd, never a project that contains the kit.
const root = requestedRoot;
assert.ok(root === kit || !(kit + sep).startsWith(root + sep), 'Run init-project from the shared kit checkout (a clone next to the project, not inside it): node <kit>/scripts/init-project.mjs --cwd <project>');
const existing = process.argv.includes('--existing');
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const present = p => lstatSync(p, { throwIfNoEntry: false });
// Every kit handler carries this id; the template files stay the only place that names it.
const ours = handler => handler.id === 'workflow-kit';

/** A project file below the checkout, reached without links, that is a plain file if it exists. */
function safe(file) {
  const target = join(root, file);
  checkDirectory(root, dirname(target));
  assert.ok(!present(target) || present(target).isFile(), `Refusing non-file target: ${file}`);
  return target;
}

function write(file, value) {
  const target = safe(file);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target) || text(target) !== value) writeFileSync(target, value);
}

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
  .filter(file => lstatSync(join(kit, 'templates', file)).isFile()).map(file => file.split(sep).join('/'));
for (const name of templates) {
  // Templates start new projects; afterwards they belong to the project and are never overwritten.
  if (!existing && !existsSync(safe(name))) write(name, text(join(kit, 'templates', name)));
}
// The kit's handlers come from the agent table and the project's functions (profile); without an entry, a file only loses them.
const features = projectFeatures(root);
const hookTemplates = new Map(Object.entries(agents).filter(([, agent]) => agent.hooks).map(([name, agent]) => [agent.hooks.file, hookSettings(name, features)]));
for (const [name, template] of hookTemplates) mergeHooks(name, template);

const patterns = ['/.vendor/workflow-kit', '/.workflow-kit/', '/.scratch/','/.impeccable/vendor/', '/.impeccable/setup-*/',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/',
  // Skills an agent reads through links stay out of Git; its own skills are committed.
  ...Object.values(agents).filter(agent => agent.linksShared).flatMap(({ skills }) => [`/${skills}/*`, ...ownSkills.map(skill => `!/${skills}/${skill}/`)])];
const ignore = existsSync(safe('.gitignore')) ? text(safe('.gitignore')) : '';
const additions = patterns.filter(p => !ignore.split('\n').includes(p));
write('.gitignore', ignore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n');
// .ignore is read by ripgrep, not git. Like .gitignore it grows by the template's missing lines, also with --existing.
// Existing text stays byte for byte: a trailing space can be significant (`name\ `).
const searchIgnore = existsSync(safe('.ignore')) ? text(safe('.ignore')) : '';
const missing = text(join(kit, 'templates/.ignore')).split('\n').filter(line => line && !searchIgnore.split('\n').includes(line));
if (missing.length) write('.ignore', searchIgnore + (searchIgnore && !searchIgnore.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
console.log('Project files configured. Generate and commit skills for this kit update; install and trust hooks explicitly.');
