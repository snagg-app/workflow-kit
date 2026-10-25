import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { entryFile } from '../agents.mjs';

const kit = fileURLToPath(new URL('../..', import.meta.url));
const hook = new URL('../kit-hook.mjs', import.meta.url).href;

test('the real entry file runs the real hook; a plain import runs nothing (#895)', t => {
  const project = mkdtempSync(join(tmpdir(), 'entry-hook '));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.agents'));
  copyFileSync(join(kit, 'scripts/kit-entry.mjs'), join(project, entryFile));
  const env = { ...process.env, WORKFLOW_KIT_DIR: kit, CLAUDE_PROJECT_DIR: project, HOME: project, USERPROFILE: project };
  const viaEntry = spawnSync(process.execPath, [join(project, entryFile), 'SessionStart', '--agent', 'claude'], { cwd: project, env, input: '{}', encoding: 'utf8' });
  assert.equal(viaEntry.status, 0, viaEntry.stderr);
  assert.equal(JSON.parse(viaEntry.stdout).hookSpecificOutput.hookEventName, 'SessionStart');

  const bogus = spawnSync(process.execPath, [join(project, entryFile), 'Bogus', '--agent', 'claude'], { cwd: project, env, input: '{}', encoding: 'utf8' });
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /^Usage: kit-hook\.mjs/);

  const imported =spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(hook)})`], { cwd: project, env, input: '{}', encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});

// #1022: a hook file that fails to load (half-updated kit) must say so, not end silently.
test('the entry file reports a hook that fails to load as a session message', t => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'entry-broken ')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.agents'));
  mkdirSync(join(project, 'scripts'));
  writeFileSync(join(project, 'scripts/kit-hook.mjs'), "import './missing-half-updated-file.mjs';\n");
  copyFileSync(join(kit, 'scripts/kit-entry.mjs'), join(project, entryFile));
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project, HOME: project, USERPROFILE: project };
  const run = spawnSync(process.execPath, [join(project, entryFile), 'SessionStart', '--agent', 'claude'], { cwd: project, env, input: '{}', encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(JSON.parse(run.stdout).systemMessage, /could not be loaded.*start the session again/s);
});

test('the real entry file links the kit in a fresh worktree without .vendor (#896)', t => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'entry-link ')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.agents'));
  copyFileSync(join(kit, 'scripts/kit-entry.mjs'), join(project, entryFile));
  const env = { ...process.env, WORKFLOW_KIT_DIR: kit, HOME: project, USERPROFILE: project };
  delete env.CLAUDE_PROJECT_DIR;
  const run = spawnSync(process.execPath, [join(project, entryFile), 'link'], { cwd: project, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(realpathSync(join(project, '.vendor/workflow-kit')), realpathSync(kit));
});
