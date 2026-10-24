import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { kitCheck } from '../kit-check.mjs';
import { isolatedGit, temporary } from './fixtures.mjs';

// #923: `start` (force) waits for another run's kit update; the hook (no force) never waits.
test('a kit lock released during the wait does not stop start, the hook stays silent at once', t => {
  const temp = temporary(t, 'kit-lock-wait ');
  const env = isolatedGit(temp);
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env, encoding: 'utf8' }).trim();
  const [upstream, kit, project] = ['upstream', 'kit', 'project'].map(name => join(temp, name));
  mkdirSync(upstream); git(upstream, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(upstream, 'AGENT_RULES.md'), 'x');
  git(upstream, 'add', '.'); git(upstream, 'commit', '--quiet', '-m', 'kit');
  git(temp, 'clone', '--quiet', upstream, kit);
  mkdirSync(join(project, '.claude'), { recursive: true }); git(project, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ id: 'workflow-kit' }] }] } }));
  git(project, 'add', '.'); git(project, 'commit', '--quiet', '-m', 'project');

  // Another run holds the kit lock (a fresh lock directory without a pid: alive by age, not abandoned).
  const lock = join(kit, '.git/kit-update.lock');
  mkdirSync(lock);
  // A separate process releases the lock after 800 ms, while this process waits synchronously.
  const releaser = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(lock)}, { recursive: true, force: true }), 800)`], { detached: true, stdio: 'ignore' });
  releaser.unref();

  const hook = kitCheck(project, { kit, update: true, fresh: 0 });
  assert.equal(hook.stuck, true, 'the hook does not wait: the held lock is reported as stuck at once');
  assert.deepEqual(hook.messages, []);

  const start = kitCheck(project, { kit, update: true, force: true, fresh: 0 });
  assert.equal(start.stuck, false, 'start waits for the released lock and goes on');
  assert.deepEqual(start.messages, []);
  rmSync(lock, { recursive: true, force: true });
});
