// Zweck: init-project an echten Dateien pruefen, ohne Netzwerk.
// Nutzen: Kit-Handler werden ersetzt; fremde Hooks, Einstellungen und Projektdateien gehen nie verloren.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { hookSettings } from '../agents.mjs';

const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const kitHook = version => ({ id: 'workflow-kit', command: `node kit-hook.mjs ${version}` });
const foreign = { command: 'sonar hook codex-prompt-submit' };
// A project hook that looks like a kit call but carries no id: it is the project's.
const lookalike = { command: 'node kit-hook.mjs project' };

/** A consumer and a shared kit next to it, with the real installer and an empty template set. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'kit migration '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'consumer'), kit = join(base, 'kit');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(join(kit, 'templates'), { recursive: true });
  mkdirSync(join(kit, 'scripts'));
  for (const script of ['init-project.mjs', 'checkout-root.mjs', 'provider-links.mjs', 'agents.mjs', 'hook-commands.json', 'project-profile.mjs']) copyFileSync(new URL(`../${script}`, import.meta.url), join(kit, 'scripts', script));
  copyFileSync(new URL('../../templates/.ignore', import.meta.url), join(kit, 'templates/.ignore'));
  const run = (...args) => spawnSync(process.execPath, [join(kit, 'scripts/init-project.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const template = (name, value) => (typeof value === 'string' ? write : json)(join(kit, 'templates', name), value);
  return { base, root, kit, run, template };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('kit handlers are replaced; foreign handlers, groups and settings stay; reruns change nothing', t => {
  const f = fixture(t), path = join(f.root, '.claude/settings.json');
  json(path, { permissions: { allow: ['x'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign, kitHook('old'), lookalike] }] } });
  json(join(f.root, '.github/workflow-project.json'), { impeccable: true });
  succeeds(f.run('--existing'));
  const generated = hookSettings('claude');
  assert.deepEqual(read(path), { ...generated, permissions: { allow: ['x'] }, hooks: { ...generated.hooks, SessionStart: [
    { matcher: 'startup', hooks: [foreign, lookalike] }, ...generated.hooks.SessionStart] } });
  const once = readFileSync(path);
  succeeds(f.run('--existing'));
  assert.deepEqual(readFileSync(path), once);
});

test('a project without UI files gets no Impeccable entry, and an old one goes; UI or the switch bring it back', t => {
  const f = fixture(t), path = join(f.root, '.claude/settings.json'), profile = join(f.root, '.github/workflow-project.json');
  const events = () => Object.keys(read(path).hooks).sort();
  const full = ['PostToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'UserPromptSubmit'];
  json(path, hookSettings('claude'));
  succeeds(f.run('--existing'));
  assert.deepEqual(events(), ['SessionStart', 'SubagentStart', 'UserPromptSubmit'], 'automatic and no UI: only Ponytail and the kit check stay');
  assert.equal(read(path).description, undefined);
  json(profile, { impeccable: false, ponytail: false });
  succeeds(f.run('--existing'));
  assert.deepEqual(events(), ['SessionStart', 'SubagentStart']);
  json(profile, { impeccable: true });
  succeeds(f.run('--existing'));
  assert.deepEqual(events(), full);
  json(profile, { impeccable: 'auto' });
  write(join(f.root, 'web/package.json'), '{"dependencies":{"react":"1"}}');
  spawnSync('git', ['init', '-q'], { cwd: f.root });
  succeeds(f.run('--existing'));
  assert.deepEqual(events(), full, 'a UI dependency in any package.json turns it on');
});

// The kit is product-neutral. Left out: the license holder, the kit's own board binding, its consumer list.
const projectConfig = new Set(['LICENSE', '.github/workflow-project.json', '.github/kit-consumers.json']);
test('no tracked kit file names a consuming product', () => {
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).stdout.split('\0').filter(file => file && !projectConfig.has(file) && statSync(new URL(`../../${file}`, import.meta.url), { throwIfNoEntry: false })?.isFile());
  assert.ok(files.length > 50);
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replaceAll('snagg-app', ''), new RegExp(['vault' + 'dex', 'sna' + 'gg'].join('|'), 'i'), file);
});

test('every shipped hook handler has the kit id and calls the hook module', () => {
  for (const [file, settings] of [['claude', hookSettings('claude')], ['codex', hookSettings('codex')], ['.claude/settings.json', read(new URL('../../.claude/settings.json', import.meta.url))], ['.codex/hooks.json', read(new URL('../../.codex/hooks.json', import.meta.url))]]) {
    const handlers = Object.values(settings.hooks).flat().flatMap(group => group.hooks);
    assert.ok(handlers.length >= 5, file);
    for (const handler of handlers) assert.ok(handler.id === 'workflow-kit' && handler.command.includes('kit-hook.mjs'), file);
  }
});

test('retired hook files lose only kit handlers', t => {
  // Copilot (.github/hooks) and Cursor (.cursor/hooks.json) are no longer supported; their kit handlers retire.
  const f = fixture(t), mixed = join(f.root, '.github/hooks/old.json'), owned = join(f.root, '.github/hooks/gone.json');
  const cursor = join(f.root, '.cursor/hooks.json');
  json(mixed, { version: 1, hooks: { sessionStart: [kitHook('old'), foreign] } });
  json(owned, { version: 1, hooks: { sessionStart: [kitHook('old')] } });
  json(cursor, { version: 1, hooks: { sessionStart: [kitHook('old')], beforeSubmitPrompt: [kitHook('old')] } });
  json(join(f.root, '.github/workflow-kit.json'), { files: {}, hooks: {} });
  succeeds(f.run('--existing'));
  assert.deepEqual(read(mixed), { version: 1, hooks: { sessionStart: [foreign] } });
  assert.equal(existsSync(owned), false);
  assert.equal(existsSync(cursor), false);
  assert.equal(existsSync(join(f.root, '.github/workflow-kit.json')), false, 'The old ownership receipt is retired');
});

test('templates start new projects and are never overwritten', t => {
  const f = fixture(t), rules = join(f.root, 'AGENTS.md');
  f.template('AGENTS.md', 'kit rules\n');
  succeeds(f.run('--existing'));
  assert.equal(existsSync(rules), false, 'Existing projects keep their own files');
  succeeds(f.run());
  assert.equal(readFileSync(rules, 'utf8'), 'kit rules\n');
  write(rules, 'project rules\n');
  f.template('AGENTS.md', 'kit rules v2\n');
  succeeds(f.run());
  assert.equal(readFileSync(rules, 'utf8'), 'project rules\n');
});

test('discovery files become trackable while custom ignores and private state stay', t => {
  const f = fixture(t), ignore = join(f.root, '.gitignore');
  write(ignore, '/.agents/hooks\n/.claude/skills/ponytail*\n/.pi/skills/impeccable\n'
    + '/.codex/agents/impeccable_*.toml\n/custom-cache/\n/.claude/skills/private/\n');
  succeeds(f.run('--existing'));
  const lines = readFileSync(ignore, 'utf8').split('\n');
  for (const removed of ['/.agents/hooks', '/.claude/skills/ponytail*', '/.pi/skills/impeccable', '/.codex/agents/impeccable_*.toml'])
    assert.ok(!lines.includes(removed), removed);
  for (const kept of ['/custom-cache/', '/.claude/skills/private/', '/.workflow-kit/', '/.scratch/', '.claude/settings.local.json', '**/skills/impeccable/scripts/bin/'])
    assert.ok(lines.includes(kept), kept);
  const once = readFileSync(ignore);
  succeeds(f.run('--existing'));
  assert.deepEqual(readFileSync(ignore), once);
  assert.equal(lines.filter(line => line === '/.scratch/').length, 1);
});

test('search ignore is created or extended without losing project lines', t => {
  const f = fixture(t), path = join(f.root, '.ignore');
  succeeds(f.run('--existing'));
  const created = readFileSync(path, 'utf8');
  assert.ok(created.split('\n').includes('/.claude/skills/*'));
  assert.ok(!created.includes('/.agents/skills'), 'One copy stays searchable');
  write(path, '/my-notes/\n!/.claude/skills/mine/\n/.pi/skills/*\nescaped\\ ');
  succeeds(f.run('--existing'));
  const lines = readFileSync(path, 'utf8').split('\n');
  assert.ok(lines.includes('/my-notes/') && lines.includes('!/.claude/skills/mine/'));
  assert.ok(lines.includes('escaped\\ '), 'A significant trailing space survives');
  assert.equal(lines.filter(line => line === '/.pi/skills/*').length, 1);
  assert.ok(lines.includes('/.vendor/'));
  const once = readFileSync(path);
  succeeds(f.run('--existing'));
  assert.deepEqual(readFileSync(path), once);
});

test('--cwd names the project to initialize, not the working directory', t => {
  const f = fixture(t), other = join(f.base, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  f.template('AGENTS.md', 'kit rules\n');
  const result = spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs'), '--cwd', f.root], { cwd: other, encoding: 'utf8' });
  succeeds(result);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'kit rules\n');
  assert.equal(existsSync(join(other, 'AGENTS.md')), false);
  assert.equal(spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs'), '--cwd', join(f.base, 'missing')], { cwd: other }).status, 2);
});

test('writes stay inside the owning checkout', t => {
  const f = fixture(t), outside = join(f.base, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(f.root, '.codex'), 'junction');
  assert.notEqual(f.run('--existing').status, 0);
  assert.equal(existsSync(join(outside, 'hooks.json')), false);
});

test('.vendor/workflow-kit becomes a link to the shared kit; reruns change nothing, another target is replaced', t => {
  const f = fixture(t), link = join(f.root, '.vendor/workflow-kit'), other = join(f.base, 'other');
  succeeds(f.run('--existing'));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync.native(link), realpathSync.native(f.kit));
  assert.ok(readFileSync(join(f.root, '.gitignore'), 'utf8').split('\n').includes('/.vendor/workflow-kit'));
  succeeds(f.run('--existing'));
  assert.equal(realpathSync.native(link), realpathSync.native(f.kit));
  rmSync(link); mkdirSync(link); writeFileSync(join(link, 'mine.txt'), 'x');
  assert.notEqual(f.run('--existing').status, 0, 'a folder with files that is no kit clone stays');
  assert.ok(existsSync(join(link, 'mine.txt')));
  rmSync(link, { recursive: true }); mkdirSync(other); symlinkSync(other, link, 'junction');
  succeeds(f.run('--existing'));
  assert.equal(realpathSync.native(link), realpathSync.native(f.kit));
  assert.ok(existsSync(other));
  // A kit inside the project it configures would link the project to itself.
  for (const script of ['init-project.mjs', 'checkout-root.mjs', 'provider-links.mjs', 'agents.mjs', 'hook-commands.json', 'project-profile.mjs']) {
    mkdirSync(join(f.root, 'inner/scripts'), { recursive: true });
    copyFileSync(new URL(`../${script}`, import.meta.url), join(f.root, 'inner/scripts', script));
  }
  assert.notEqual(spawnSync(process.execPath, [join(f.root, 'inner/scripts/init-project.mjs'), '--cwd', f.root, '--existing']).status, 0);
});

test('a submodule from the pin era is replaced: gitlink, .gitmodules entry and clone go, but never unpublished work', t => {
  const f = fixture(t), link = join(f.root, '.vendor/workflow-kit');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(f.base, 'gitconfig'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const old = join(f.base, 'old-kit');
  mkdirSync(old); git(old, 'init', '--quiet'); writeFileSync(join(old, 'AGENT_RULES.md'), 'x'); git(old, 'add', '.'); git(old, 'commit', '--quiet', '-m', 'kit');
  rmSync(join(f.root, '.git'), { recursive: true }); git(f.root, 'init', '--quiet');
  git(f.root, 'submodule', '--quiet', 'add', old.replaceAll('\\', '/'), '.vendor/workflow-kit');
  git(f.root, 'commit', '--quiet', '-m', 'consumer');
  git(link, 'commit', '--quiet', '--allow-empty', '-m', 'mine');
  const refused = f.run('--existing');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unpublished commits/);
  assert.ok(existsSync(join(link, 'AGENT_RULES.md')), 'nothing was removed');
  git(link, 'reset', '--quiet', '--hard', 'origin/HEAD');
  succeeds(f.run('--existing'));
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(git(f.root, 'ls-files', '-s', '--', '.vendor'), '', 'no gitlink');
  assert.ok(!existsSync(join(f.root, '.gitmodules')), 'no .gitmodules entry');
  assert.ok(!existsSync(join(f.root, '.git/modules/.vendor/workflow-kit')), 'the old clone is gone');
});
