// Zweck: init-project an echten Dateien pruefen, ohne Netzwerk.
// Nutzen: Kit-Handler werden ersetzt; fremde Hooks, Einstellungen und Projektdateien gehen nie verloren.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const kitHook = version => ({ command: `sh "$HOME/.ponytail/workflow-kit/${version}/launch.sh" activate` });
const foreign = { command: 'sonar hook codex-prompt-submit' };
const staleBranchHook = { command: 'git -C "$root" merge-base --is-ancestor HEAD "$base" || continue' };

/** A consumer with the real installer at .vendor/workflow-kit and an empty template set. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'kit migration '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'consumer'), kit = join(root, '.vendor/workflow-kit');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(kit, 'templates'), { recursive: true });
  mkdirSync(join(kit, 'scripts'));
  for (const script of ['init-project.mjs', 'checkout-root.mjs', 'provider-links.mjs']) copyFileSync(new URL(`../${script}`, import.meta.url), join(kit, 'scripts', script));
  copyFileSync(new URL('../../templates/.ignore', import.meta.url), join(kit, 'templates/.ignore'));
  const run = (...args) => spawnSync(process.execPath, [join(kit, 'scripts/init-project.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const template = (name, value) => (typeof value === 'string' ? write : json)(join(kit, 'templates', name), value);
  return { base, root, kit, run, template };
}
const succeeds = result => assert.equal(result.status, 0, result.stderr);

test('kit handlers are replaced; foreign handlers, groups and settings stay; reruns change nothing', t => {
  const f = fixture(t), path = join(f.root, '.claude/settings.json');
  json(path, { permissions: { allow: ['x'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign, kitHook('old'), staleBranchHook] }] } });
  f.template('.claude/settings.json', { description: 'kit', hooks: { SessionStart: [{ matcher: 'startup', hooks: [kitHook('new')] }] } });
  succeeds(f.run('--existing'));
  assert.deepEqual(read(path), { description: 'kit', permissions: { allow: ['x'] }, hooks: { SessionStart: [
    { matcher: 'startup', hooks: [foreign] }, { matcher: 'startup', hooks: [kitHook('new')] }] } });
  const once = readFileSync(path);
  succeeds(f.run('--existing'));
  assert.deepEqual(readFileSync(path), once);
});

// The kit is product-neutral. Left out: the license holder, the kit's own board binding, its consumer list and the secret name in the notify workflow.
const projectConfig = new Set(['LICENSE', '.github/workflow-project.json', '.github/kit-consumers.json', '.github/workflows/notify-consumers.yml']);
test('no tracked kit file names a consuming product', () => {
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).stdout.split('\0').filter(file => file && !projectConfig.has(file) && statSync(new URL(`../../${file}`, import.meta.url), { throwIfNoEntry: false })?.isFile());
  assert.ok(files.length > 50);
  for (const file of files) assert.doesNotMatch(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replaceAll('snagg-app', ''), new RegExp(['vault' + 'dex', 'sna' + 'gg'].join('|'), 'i'), file);
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
  f.template('.codex/hooks.json', { hooks: { SessionStart: [{ hooks: [kitHook('new')] }] } });
  assert.notEqual(f.run('--existing').status, 0);
  assert.equal(existsSync(join(outside, 'hooks.json')), false);
  const other = join(f.base, 'other');
  mkdirSync(join(other, '.git'), { recursive: true });
  assert.notEqual(spawnSync(process.execPath, [join(f.kit, 'scripts/init-project.mjs')], { cwd: other }).status, 0, 'Only the owning checkout');
});
