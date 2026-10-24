import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(hook)})`], { cwd: project, env, input: '{}', encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});
