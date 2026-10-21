import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedGit, run, temporary } from './fixtures.mjs';
import { keepReason, orphanVolumes, rootHashes } from '../worktree-gc.mjs';

const script = fileURLToPath(new URL('../worktree-gc.mjs', import.meta.url));
const finished = { dirty: false, unpushed: 0, busy: false, locked: null, ageMinutes: 1000 };

test('only a clean, pushed, idle, old worktree is finished; each guard keeps it', () => {
  assert.equal(keepReason(finished), null);
  assert.ok(keepReason({ ...finished, dirty: true }));
  assert.ok(keepReason({ ...finished, dirty: undefined }), 'unknown state counts as dirty');
  assert.ok(keepReason({ ...finished, unpushed: 2 }));
  assert.ok(keepReason({ ...finished, unpushed: null }), 'unknown state counts as unpushed');
  assert.ok(keepReason({ ...finished, busy: true }));
  assert.ok(keepReason({ ...finished, locked: 'claude agent (pid 1)', lockAlive: true }));
  assert.ok(keepReason({ ...finished, locked: 'no pid in here' }));
  assert.ok(keepReason({ ...finished, ageMinutes: 5 }));
  assert.ok(keepReason({ ...finished, main: true }));
  assert.equal(keepReason({ ...finished, locked: 'dead (pid 1)', lockAlive: false }), null);
  assert.equal(keepReason({ ...finished, ageMinutes: 0, locked: 'x' }, { explicit: true }), null, '--only skips lock and age');
  assert.ok(keepReason({ ...finished, dirty: true }, { explicit: true }), '--only never skips the safety checks');
});

test('volumes: snagg331 is never touched, living roots keep theirs, other names are ignored', () => {
  const live = new Set(rootHashes('/work/live'));
  const gone = rootHashes('/work/gone')[0];
  const names = [`cache-${live.values().next().value}`, `cache-${gone}`, `cache-${gone}-build-api`, `other-${gone}`, 'cache-nothex000000', `snagg331_${gone}`];
  assert.deepEqual(orphanVolumes(names, ['cache-'], live), [`cache-${gone}`, `cache-${gone}-build-api`]);
  assert.deepEqual(orphanVolumes(names, ['snagg331_'], live), [], 'a prefix naming snagg331 deletes nothing');
});

test('dry run is the default and deletes nothing; --rm deletes only finished worktrees', async t => {
  const dir = temporary(t, 'worktree-gc-');
  const env = { ...isolatedGit(dir), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '--bare', '-b', 'main', origin);
  const main = join(dir, 'main');
  git(dir, 'clone', origin, main);
  git(main, 'commit', '--allow-empty', '-m', 'start');
  git(main, 'push', 'origin', 'main');
  const add = (name, ...extra) => { git(main, 'worktree', 'add', '-b', name, join(dir, name)); for (const args of extra) git(join(dir, name), ...args); return join(dir, name); };
  const done = add('done', ['push', 'origin', 'done']);
  const dirty = add('dirty');
  writeFileSync(join(dirty, 'note.txt'), 'unsaved');
  const unpushed = add('unpushed', ['commit', '--allow-empty', '-m', 'only here']);
  const locked = add('locked');
  git(main, 'worktree', 'lock', '--reason', `claude agent (pid ${process.pid})`, locked);
  mkdirSync(join(done, 'node_modules/x'), { recursive: true });

  const gc = (...args) => run(process.execPath, [script, '--cwd', main, '--min-age', '0', ...args], { env });
  const dry = await gc();
  assert.equal(dry.status, 0, dry.stderr);
  for (const path of [done, dirty, unpushed, locked]) assert.ok(existsSync(path), `${path} survives the dry run`);
  assert.match(dry.stdout, /1 finished/);

  const real = await gc('--rm');
  assert.equal(real.status, 0, real.stderr);
  assert.ok(!existsSync(done), 'finished worktree is gone');
  for (const path of [dirty, unpushed, locked]) assert.ok(existsSync(path), `${path} is kept`);
  assert.ok(!git(main, 'branch', '--list', 'done').trim(), 'its local branch is gone');
  assert.ok(git(main, 'branch', '--list', 'unpushed').trim(), 'the branch with unpushed commits stays');
});
