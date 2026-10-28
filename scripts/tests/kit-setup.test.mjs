import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { statusMismatch } from '../project-profile.mjs';
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
  const env = { ...process.env, HOME: home, USERPROFILE: home, IMPECCABLE_DOWNLOAD_BASE: 'http://127.0.0.1:9', KIT_NODE_SETUP: 'skip' };
  const run = (extra = {}) => spawnSync(process.execPath, [join(kit, 'scripts/kit.mjs'), '--cwd', project, 'setup'], { encoding: 'utf8', env: { ...env, ...extra } });
  return { project, home, run, env };
}

test('kit setup sets up an empty project and a second run changes nothing', { skip: skipWithoutSubmodules() }, t => {
  const { project, home, run } = setup(t);
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Only you can do:/);
  assert.match(first.stdout, /No agent found in the project; hooks written for all: /, 'the notes of the steps show up');
  assert.match(first.stdout, /ok {4}kit check/, 'setup runs the session-start check');
  assert.match(first.stdout, /ok {4}Impeccable hooks: off for this project/, 'an empty project has no UI files: no Impeccable download');
  for (const file of ['AGENTS.md', '.github/workflow-project.json', '.claude/settings.json', '.codex/hooks.json', '.agents/skills/ponytail/SKILL.md', '.claude/skills/find-skills/SKILL.md'])
    assert.ok(existsSync(join(project, file)), file);
  assert.ok(lstatSync(join(project, '.vendor/workflow-kit')).isSymbolicLink() || lstatSync(join(project, '.vendor/workflow-kit')).isDirectory());
  const before = [snapshot(project), snapshot(home)];
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual([snapshot(project), snapshot(home)], before);
});

test('kit setup does not write the profile through a link that leaves the project (#797)', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t), outside = temporary(t, 'kit setup outside ');
  writeFileSync(join(project, 'AGENTS.md'), 'own\n');
  symlinkSync(outside, join(project, '.github'), 'junction');
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL {2}profile/);
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the link');
});

test('importing kit.mjs runs no step; kitSetup returns the result instead of exiting (#825)', { skip: skipWithoutSubmodules() }, async t => {
  const { project } = setup(t), outside = temporary(t, 'kit setup outside ');
  const { kitSetup } = await import('../kit.mjs');
  assert.equal(typeof kitSetup, 'function');
  assert.deepEqual(readdirSync(project).filter(name => name !== '.git'), [], 'the import changed nothing');
  writeFileSync(join(project, 'AGENTS.md'), 'own\n');
  symlinkSync(outside, join(project, '.github'), 'junction');
  const seen = [];
  const result = await kitSetup(project, { onStep: step => seen.push(step.title) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.steps.at(-1).state, 'error');
  assert.deepEqual(seen, result.steps.map(step => step.title));
  assert.deepEqual(readdirSync(outside), []);
});

test('kit setup leaves a project that is already bound to its board alone, without any network call (#730)', { skip: skipWithoutSubmodules() }, t => {
  const { project, home, run, env } = setup(t);
  mkdirSync(join(project, '.github'));
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  writeFileSync(join(project, '.github/workflow-project.json'), JSON.stringify({ language: 'en', repository: 'acme/App', owner: 'acme', number: 4, id: 'PVT_x', url: 'https://github.com/orgs/acme/projects/4' }));
  // A gh that fails loudly: any call means the board step ran.
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh called" >&2\nexit 1\n');
  writeFileSync(join(bin, 'gh.cmd'), '@echo gh called 1>&2\r\n@exit /b 1\r\n');
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', join(bin, 'gh')]);
  const result = run({ PATH: bin + (process.platform === 'win32' ? ';' : ':') + env.PATH });
  assert.match(result.stdout, /ok {4}GitHub board and labels: already bound/, result.stdout + result.stderr);
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
  assert.equal(existsSync(join(project, 'CONTRIBUTING.md')), false, 'an existing project gets no starter files');});

test('kit setup lists the git hooks as open when a foreign core.hooksPath blocks them (#1026)', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t);
  mkdirSync(join(project, '.githooks'));
  writeFileSync(join(project, '.githooks/pre-push'), '#!/bin/sh\n');
  execFileSync('git', ['-C', project, 'config', '--local', 'core.hooksPath', '.husky']);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /open {2}git hooks \(\.githooks\)/, result.stdout);
  assert.match(result.stdout, /Only you can do:[\s\S]*Fix "git hooks \(\.githooks\)"/, result.stdout);
});

test('kit setup leaves a committed hook entry file as it is and says so once (#985)', { skip: skipWithoutSubmodules() }, t => {
  const { project, run } = setup(t);
  mkdirSync(join(project, '.agents'));
  writeFileSync(join(project, '.agents/workflow-kit-hook.mjs'), '// older kit\n');
  execFileSync('git', ['-C', project, 'add', '.agents/workflow-kit-hook.mjs']);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(project, '.agents/workflow-kit-hook.mjs'), 'utf8'), '// older kit\n');
  assert.equal(result.stdout.match(/Kept \d+ committed kit file/g)?.length, 1, result.stdout);
});

test('a board with a differently named status is told which name is missing and how to map it', () => {
  const board = ['Backlog', 'Ready', 'In progress', 'Auto review', 'Human review', 'Done'];
  assert.equal(statusMismatch([...board.slice(0, 3), 'Automated review', ...board.slice(4)], {}), null);
  const message = statusMismatch(board, {});
  assert.match(message, /Missing on the board: "Automated review"/);
  assert.match(message, /Not expected: "Auto review"/);
  assert.match(message, /"statuses":\{"automatedReview":"Auto review"\}/);
  assert.equal(statusMismatch(board, { statuses: { automatedReview: 'Auto review' } }), null, 'the mapped name is accepted');
  assert.match(statusMismatch(['Ready', 'Backlog', 'In progress', 'Automated review', 'Human review', 'Done'], {}), /order differs/);
});
