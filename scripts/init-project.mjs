// Zweck: Kit-Hooks, .gitignore und .ignore (Suche) in das Projekt übernehmen; neue Projekte erhalten die Vorlagen.
// Aufruf: Bei Einrichtung oder Kit-Updates; --existing lässt die Vorlagen weg.
// Nutzen: Kit-Handler werden am Befehl erkannt und ersetzt; fremde Hooks und Einstellungen bleiben.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { checkDirectory } from './provider-links.mjs';

const kit = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
enterCwd(); // `--cwd PROJECT_DIR` as the first argument
const requestedRoot = projectRoot();
// The installed kit owns only itself or the checkout it is vendored into.
const root = requestedRoot === kit ? kit : resolve(kit, '../..');
assert.equal(requestedRoot, root, 'Run init-project inside the project that vendors this kit at .vendor/workflow-kit');
if (root !== kit) assert.equal(relative(root, kit).split(sep).join('/'), '.vendor/workflow-kit', 'Install the kit at .vendor/workflow-kit in the target');
const existing = process.argv.includes('--existing');
const text = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const present = p => lstatSync(p, { throwIfNoEntry: false });
// Kit handlers call the personal snapshots under ~/.ponytail/workflow-kit or ~/.impeccable/workflow-kit (earlier kits: vaultdex); older ones
// built that path with path.join('.ponytail','vaultdex',…) or only printed the installer hint;
// the kit init handler is recognized by its gitlink check followed by the submodule init,
// the stale-branch handler by its ancestor test of HEAD against the fetched base,
// the node_modules handler by its message.
const ours = handler => /node_modules is missing in this worktree|\.(?:ponytail|impeccable)(?:[\\/]+|',\s*')(?:vaultdex|workflow-kit)(?:[\\/]|')|install-(?:ponytail|impeccable)-hooks\.mjs|merge-base --is-ancestor HEAD|ls-files -s -- \.vendor\/workflow-kit[\s\S]*submodule update --init --checkout \.vendor\/workflow-kit/
  .test(JSON.stringify(handler));
const isHooks = name => /^(?:\.(?:codex|cursor)\/hooks\.json|\.claude\/settings\.json|\.github\/hooks\/[\w.-]+\.json)$/.test(name);

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
  for (const [event, groups] of Object.entries(template?.hooks ?? {})) hooks[event] = [...(hooks[event] ?? []), ...groups];
  // Template keys are schema metadata (version, description) and advance with the kit; other settings stay.
  const merged = { ...template, ...current, ...template, hooks };
  // A file that held only kit handlers and schema metadata goes when its template is retired.
  if (!template && !Object.keys(hooks).length && Object.keys(merged).every(key => ['hooks', 'version', 'description'].includes(key))) {
    if (existsSync(target)) unlinkSync(target);
  } else if (existsSync(target) || template) write(name, JSON.stringify(merged, null, 2) + '\n');
}

const templates = readdirSync(join(kit, 'templates'), { recursive: true })
  .filter(file => lstatSync(join(kit, 'templates', file)).isFile()).map(file => file.split(sep).join('/'));
for (const name of templates.filter(name => !isHooks(name))) {
  // Templates start new projects; afterwards they belong to the project and are never overwritten.
  if (!existing && !existsSync(safe(name))) write(name, text(join(kit, 'templates', name)));
}
const hookTemplates = new Map(templates.filter(isHooks).map(name => [name, JSON.parse(text(join(kit, 'templates', name)))]));
// Cursor and Copilot are no longer supported: without a template, their files only lose the kit's handlers.
const githubHooks = existsSync(join(root, '.github/hooks')) ? readdirSync(join(root, '.github/hooks')).map(file => `.github/hooks/${file}`) : [];
for (const name of new Set([...hookTemplates.keys(), '.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', ...githubHooks]))
  if (isHooks(name) && (hookTemplates.has(name) || existsSync(safe(name)))) mergeHooks(name, hookTemplates.get(name));

// Includes providers the kit no longer supports: their old ignore lines are still removed.
const providers = ['.agent', '.agents', '.claude', '.opencode', '.pi'];
// Remove only exact obsolete patterns emitted by earlier kit versions; project ignores stay.
const legacy = new Set(['/.agents/hooks/', ...providers.map(p => `/${p}/skills/ponytail*/`), '/.agents/hooks',
  ...providers.flatMap(p => [`/${p}/skills/ponytail*`, `/${p}/skills/impeccable`]),
  '/.claude/agents/impeccable-*.md', '/.codex/agents/impeccable_*.toml', '/.opencode/commands/impeccable.md']);
const patterns = ['/.workflow-kit/', '/.scratch/','/.impeccable/vendor/', '/.impeccable/setup-*/',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/'];
const ignore = existsSync(safe('.gitignore')) ? text(safe('.gitignore')).split('\n').filter(line => !legacy.has(line)).join('\n') : '';
const additions = patterns.filter(p => !ignore.split('\n').includes(p));
write('.gitignore', ignore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n');
// .ignore is read by ripgrep, not git. Like .gitignore it grows by the template's missing lines, also with --existing.
// Existing text stays byte for byte: a trailing space can be significant (`name\ `).
const searchIgnore = existsSync(safe('.ignore')) ? text(safe('.ignore')) : '';
const missing = text(join(kit, 'templates/.ignore')).split('\n').filter(line => line && !searchIgnore.split('\n').includes(line));
if (missing.length) write('.ignore', searchIgnore + (searchIgnore && !searchIgnore.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
// Earlier kit versions tracked ownership in a receipt; handlers are now recognized by their commands.
if (existsSync(safe('.github/workflow-kit.json'))) unlinkSync(safe('.github/workflow-kit.json'));
console.log('Project files configured. Generate and commit skills for this kit update; install and trust hooks explicitly.');
