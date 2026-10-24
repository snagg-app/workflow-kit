import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloneKit } from '../kit-entry.mjs';

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-clone ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  mkdirSync(join(origin, 'scripts'), { recursive: true });
  writeFileSync(join(origin, 'scripts/kit-hook.mjs'), '');
  git(origin, 'init', '--quiet');
  git(origin, 'add', '.');
  git(origin, 'commit', '--quiet', '-m', 'kit');
  return { root, origin, kit: join(root, 'workflow-kit') };
}

test('a half folder from an aborted clone does not block the next start (#974)', t => {
  const { root, origin, kit } = fixture(t);
  mkdirSync(join(kit, '.git'), { recursive: true });
  assert.equal(cloneKit(kit, origin), '');
  assert.ok(existsSync(join(kit, 'scripts/kit-hook.mjs')));
  assert.deepEqual(readdirSync(root).sort(), ['origin', 'workflow-kit']);
});

test('a folder with foreign files is never deleted; the message names it (#974)', t => {
  const { root, origin, kit } = fixture(t);
  mkdirSync(kit);
  writeFileSync(join(kit, 'mine.txt'), 'work');
  const error = cloneKit(kit, origin);
  assert.ok(error.includes(kit), error);
  assert.ok(existsSync(join(kit, 'mine.txt')));
  assert.deepEqual(readdirSync(root).sort(), ['origin', 'workflow-kit']);
});

test('without git the start hook names the missing kit instead of crashing (#986)', t => {
  const { root } = fixture(t);
  const empty = join(root, 'empty');
  mkdirSync(empty);
  const entry = join(import.meta.dirname, '..', 'kit-entry.mjs');
  const env = { PATH: empty, CLAUDE_PROJECT_DIR: root };
  const run = spawnSync(process.execPath, [entry, 'SessionStart'], { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /shared Workflow Kit checkout is missing/);
});

test('a failed clone leaves no folder and reports the real git error (#974)', t => {
  const { root, kit } = fixture(t);
  const error = cloneKit(kit, join(root, 'missing'));
  assert.match(error, /does not exist|not found|Could not read|repository/i);
  assert.deepEqual(readdirSync(root).sort(), ['origin']);
});
