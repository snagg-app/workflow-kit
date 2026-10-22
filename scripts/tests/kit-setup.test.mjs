import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { kitCheckout, skipWithoutSubmodules, temporary } from './fixtures.mjs';

/** Every file below `dir` (links by target, the .git folder skipped) with a hash of its content. */
function snapshot(dir, base = dir, found = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), name = path.slice(base.length);
    if (entry.name === '.git') continue;
    if (lstatSync(path).isSymbolicLink()) found[name] = readlinkSync(path);
    else if (entry.isDirectory()) snapshot(path, base, found);
    else found[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return found;
}

function setup(t) {
  const kit = kitCheckout(t), project = temporary(t, 'kit setup project '), home = temporary(t, 'kit setup home ');
  execFileSync('git', ['init', '--quiet', project]);
  // No network: the Impeccable engine download fails fast and counts as an open step.
  const env = { ...process.env, HOME: home, USERPROFILE: home, IMPECCABLE_DOWNLOAD_BASE: 'http://127.0.0.1:9' };
  const run = () => spawnSync(process.execPath, [join(kit, 'scripts/kit.mjs'), '--cwd', project, 'setup'], { encoding: 'utf8', env });
  return { project, home, run };
}

test('kit setup sets up an empty project and a second run changes nothing', { skip: skipWithoutSubmodules() }, t => {
  const { project, home, run } = setup(t);
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Only you can do:/);
  assert.match(first.stdout, /ok {4}Impeccable hooks: off for this project/, 'an empty project has no UI files: no Impeccable download');
  for (const file of ['AGENTS.md', '.github/workflow-project.json', '.claude/settings.json', '.codex/hooks.json', '.agents/skills/ponytail/SKILL.md', '.claude/skills/find-skills/SKILL.md'])
    assert.ok(existsSync(join(project, file)), file);
  assert.ok(lstatSync(join(project, '.vendor/workflow-kit')).isSymbolicLink() || lstatSync(join(project, '.vendor/workflow-kit')).isDirectory());
  const before = [snapshot(project), snapshot(home)];
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual([snapshot(project), snapshot(home)], before);
});

test('kit setup keeps the own hooks, settings and AGENTS.md of an existing project', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t);
  mkdirSync(join(project, '.claude'));
  const own = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ id: 'mine', type: 'command', command: 'echo mine' }] }] } };
  writeFileSync(join(project, '.claude/settings.json'), JSON.stringify(own));
  writeFileSync(join(project, 'AGENTS.md'), 'my rules\n');
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const settings = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions, own.permissions);
  assert.ok(settings.hooks.Stop.some(group => group.hooks.some(handler => handler.id === 'mine')));
  assert.ok(settings.hooks.SessionStart.some(group => group.hooks.some(handler => handler.id === 'workflow-kit')));
  assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), 'my rules\n');
  assert.equal(existsSync(join(project, 'CONTRIBUTING.md')), false, 'an existing project gets no starter files');
});
