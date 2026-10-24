import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { kitCheck } from '../kit-check.mjs';
import { isolatedGit, temporary } from './fixtures.mjs';

function fixture(t) {
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
  return { temp, kit, project };
}

// #923: `start` (force) waits for another run's kit update; the hook (no force) never waits.
test('a kit lock released during the wait does not stop start, the hook stays silent at once', t => {
  const { temp, kit, project } = fixture(t);

  // Another run holds the kit lock (a fresh lock directory without a pid: alive by age, not abandoned).
  const lock = join(kit, '.git/kit-update.lock');
  mkdirSync(lock);
  // A separate process releases the lock after 800 ms, while this process waits synchronously.
  const releaserFile = join(temp, 'release-lock.mjs');
  writeFileSync(releaserFile, "import { rmSync } from 'node:fs';\nsetTimeout(() => rmSync(process.argv[2], { recursive: true, force: true }), 800);\n");
  const releaser = spawn(process.execPath, [releaserFile, lock], { detached: true, stdio: 'ignore' });
  releaser.unref();

  const hook = kitCheck(project, { kit, update: true, fresh: 0 });
  assert.equal(hook.stuck, true, 'the hook does not wait: the held lock is reported as stuck at once');
  assert.deepEqual(hook.messages, []);

  const start = kitCheck(project, { kit, update: true, force: true, fresh: 0 });
  assert.equal(start.stuck, false, 'start waits for the released lock and goes on');
  assert.deepEqual(start.messages, []);
  rmSync(lock, { recursive: true, force: true });
});

// #929: a held lock says "run again" and names lock, PID and age; a changed kit checkout says a human must act.
test('start tells a held kit lock (retry, with path and PID) from a changed kit checkout (human)', t => {
  const { kit, project } = fixture(t);
  const lock = join(kit, '.git/kit-update.lock');
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.pid));
  const held = kitCheck(project, { kit, update: true, force: true, fresh: 0, wait: 0 });
  assert.deepEqual([held.stuck, held.retry], [true, true]);
  assert.ok(held.messages[0].includes(lock) && held.messages[0].includes(`PID ${process.pid}`) && /\d+ s/.test(held.messages[0]), held.messages[0]);
  rmSync(lock, { recursive: true, force: true });

  writeFileSync(join(kit, 'AGENT_RULES.md'), 'changed');
  const dirty = kitCheck(project, { kit, update: true, force: true, fresh: 0, wait: 0 });
  assert.deepEqual([dirty.stuck, dirty.retry], [true, false]);
});
