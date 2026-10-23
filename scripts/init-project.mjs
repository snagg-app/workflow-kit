// Zweck: Kit-Verknüpfung, Kit-Hooks, .gitignore und .ignore (Suche) in das Projekt übernehmen; neue Projekte erhalten die Vorlagen.
// Aufruf: Bei Einrichtung oder Kit-Updates, aus dem gemeinsamen Kit-Checkout (--cwd PROJEKT); --existing lässt die Vorlagen weg.
// Nutzen: .vendor/workflow-kit zeigt auf den gemeinsamen Checkout (ein alter Gitlink entfällt); Kit-Handler werden an ihrer Kennung ersetzt; fremde Hooks und Einstellungen bleiben.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterCwd, projectRoot } from './checkout-root.mjs';
import { agents, hookFiles, hookSettings, ownSkills, providers as skillProviders } from './agents.mjs';
import { checkDirectory } from './provider-links.mjs';
import { languages, projectFeatures, readProfile } from './project-profile.mjs';

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
// Cursor and Copilot are no longer supported: their files only lose the kit's handlers.
const retiredHooks = /^(?:\.cursor\/hooks\.json|\.github\/hooks\/[\w.-]+\.json)$/;
const isHooks = name => hookFiles.includes(name) || retiredHooks.test(name);

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
  if (template && !template.description) delete merged.description; // the Impeccable description goes with its hooks
  // A file that held only kit handlers and schema metadata goes when its template is retired.
  if (!template && !Object.keys(hooks).length && Object.keys(merged).every(key => ['hooks', 'version', 'description'].includes(key))) {
    if (existsSync(target)) unlinkSync(target);
  } else if (existsSync(target) || template) write(name, JSON.stringify(merged, null, 2) + '\n');
}

/** `.vendor/workflow-kit` is a link to the shared kit, not a submodule: a leftover gitlink, its .gitmodules entry and its clone go. */
function linkKit() {
  const link = join(root, '.vendor/workflow-kit'), git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const entry = present(link);
  if (entry && !entry.isSymbolicLink()) {
    const kitGit = join(link, '.git');
    // Work that a removal would lose stays: refuse, and name the way out.
    if (existsSync(kitGit)) {
      const lost = execFileSync('git', ['-C', link, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
        || execFileSync('git', ['-C', link, 'rev-list', '-n', '1', 'HEAD', '--not', '--remotes'], { encoding: 'utf8' }).trim();
      assert.ok(!lost, '.vendor/workflow-kit has local changes or unpublished commits: commit, push or discard them, then run init-project again');
    }
    // A folder that is no clone is only removed when empty (an uninitialized submodule).
    assert.ok(existsSync(kitGit) || !entry.isDirectory() || !readdirSync(link).length, '.vendor/workflow-kit is a folder with files that are no kit clone: move it away, then run init-project again');
    if (git('ls-files', '-s', '--', '.vendor/workflow-kit').startsWith('160000')) git('rm', '-f', '-q', '--', '.vendor/workflow-kit');
    rmSync(link, { recursive: true, force: true });
    rmSync(join(git('rev-parse', '--absolute-git-dir'), 'modules/.vendor/workflow-kit'), { recursive: true, force: true });
    // An emptied .gitmodules goes too.
    if (existsSync(join(root, '.gitmodules')) && !text(join(root, '.gitmodules')).trim()) git('rm', '-f', '-q', '--', '.gitmodules');
  }
  if (entry?.isSymbolicLink() && realpathSyncOr(link) === kit) return;
  rmSync(link, { force: true });
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(kit, link, 'junction'); // a junction on Windows, which needs no privilege; a symlink elsewhere
}
const realpathSyncOr = file => { try { return realpathSync.native(file); } catch { return ''; } };
if (root !== kit) linkKit();

const templates = readdirSync(join(kit, 'templates'), { recursive: true })
  .filter(file => lstatSync(join(kit, 'templates', file)).isFile()).map(file => file.split(sep).join('/'));
const language = readProfile(root).language ?? 'en';
for (const file of templates) {
  // templates/<language>/ holds the texts that differ by language; the project gets the one of its profile.
  const [first, ...rest] = file.split('/');
  const name = languages.includes(first) ? (first === language ? rest.join('/') : null) : file;
  // Templates start new projects; afterwards they belong to the project and are never overwritten.
  if (name && !existing && !existsSync(safe(name))) write(name, text(join(kit, 'templates', file)));
}
// The kit's handlers come from the agent table and the project's functions (profile); without an entry, a file only loses them.
const features = projectFeatures(root);
const hookTemplates = new Map(Object.entries(agents).filter(([, agent]) => agent.hooks).map(([name, agent]) => [agent.hooks.file, hookSettings(name, features)]));
const githubHooks = existsSync(join(root, '.github/hooks')) ? readdirSync(join(root, '.github/hooks')).map(file => `.github/hooks/${file}`) : [];
for (const name of new Set([...hookTemplates.keys(), '.cursor/hooks.json', ...githubHooks]))
  if (isHooks(name) && (hookTemplates.has(name) || existsSync(safe(name)))) mergeHooks(name, hookTemplates.get(name));

// Includes providers the kit no longer supports: their old ignore lines are still removed.
const providers = ['.agent', '.opencode', '.pi', ...skillProviders];
// Remove only exact obsolete patterns emitted by earlier kit versions; project ignores stay.
const legacy = new Set(['/.agents/hooks/', ...providers.map(p => `/${p}/skills/ponytail*/`), '/.agents/hooks',
  ...providers.flatMap(p => [`/${p}/skills/ponytail*`, `/${p}/skills/impeccable`]),
  '/.claude/agents/impeccable-*.md', '/.codex/agents/impeccable_*.toml', '/.opencode/commands/impeccable.md']);
const patterns = ['/.vendor/workflow-kit', '/.workflow-kit/', '/.scratch/','/.impeccable/vendor/', '/.impeccable/setup-*/',
  '.claude/settings.local.json', '**/.impeccable/config.local.json', '**/skills/impeccable/scripts/bin/',
  // Skills an agent reads through links stay out of Git; its own skills are committed.
  ...Object.values(agents).filter(agent => agent.linksShared).flatMap(({ skills }) => [`/${skills}/*`, ...ownSkills.map(skill => `!/${skills}/${skill}/`)])];
const ignore = existsSync(safe('.gitignore')) ? text(safe('.gitignore')).split('\n').filter(line => !legacy.has(line)).join('\n') : '';
const additions = patterns.filter(p => !ignore.split('\n').includes(p));
write('.gitignore', ignore.trimEnd() + (additions.length ? '\n' + additions.join('\n') : '') + '\n');
// .ignore is read by ripgrep, not git. Like .gitignore it grows by the template's missing lines, also with --existing.
// Existing text stays byte for byte: a trailing space can be significant (`name\ `).
const searchIgnore = existsSync(safe('.ignore')) ? text(safe('.ignore')) : '';
const missing = text(join(kit, 'templates/.ignore')).split('\n').filter(line => line && !searchIgnore.split('\n').includes(line));
if (missing.length) write('.ignore', searchIgnore + (searchIgnore && !searchIgnore.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
// Earlier kit versions tracked ownership in a receipt; handlers are now recognized by their id.
if (existsSync(safe('.github/workflow-kit.json'))) unlinkSync(safe('.github/workflow-kit.json'));
console.log('Project files configured. Generate and commit skills for this kit update; install and trust hooks explicitly.');
