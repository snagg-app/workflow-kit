import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedGit, run, temporary } from './fixtures.mjs';
import { busyFrom, goneWorkdir, keepReason, mergedHeads, orphanVolumes, rootHashes, unpushedCount, unpushedFor } from '../worktree-gc.mjs';

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

test('an unreadable process list counts as busy, so a worktree is kept when we cannot see whether it runs', () => {
  const path = resolve('/work/tree');
  assert.equal(busyFrom({ ok: true, out: '42\t1\tnode /elsewhere/tool.mjs' }, path), false);
  assert.equal(busyFrom({ ok: true, out: `42\t1\tnode ${path}/tool.mjs` }, path), true);
  assert.equal(busyFrom({ ok: false, out: '' }, path), true);
});

test('the shells that started the script carry the path too and do not count as busy, a foreign process still does', () => {
  const path = resolve('/work/tree');
  const chain = [`10\t1\tbash -c "node gc.mjs --only ${path}"`, `20\t10\tbash -c "node gc.mjs --only ${path}"`, '30\t20\tnode gc.mjs'].join('\n');
  assert.equal(busyFrom({ ok: true, out: chain }, path, 30), false);
  assert.equal(busyFrom({ ok: true, out: `${chain}\n99\t1\tvim ${path}/file` }, path, 30), true);
  assert.equal(busyFrom({ ok: true, out: `${chain}\n99\t10\tnode ${path}/sibling.mjs` }, path, 30), true, 'a child of the shell is no ancestor');
});

test('a failed count of unpushed commits is unknown and keeps the worktree, never zero', () => {
  assert.equal(unpushedCount({ ok: false, out: '' }), null);
  assert.ok(keepReason({ ...finished, unpushed: unpushedCount({ ok: false, out: '' }) }));
  assert.equal(unpushedCount({ ok: true, out: '0\n' }), 0);
  assert.equal(unpushedCount({ ok: true, out: '3\n' }), 3);
  assert.equal(unpushedCount({ ok: true, out: '' }), null, 'empty output is unknown too');
});

test('an unknown count stays unknown even when the HEAD belongs to a closed PR', () => {
  assert.equal(unpushedFor(null, true), null, 'failed count + closed PR head keeps the worktree');
  assert.equal(unpushedFor(3, true), 0, 'known commits of a closed PR count as saved');
  assert.equal(unpushedFor(3, false), 3);
});

test('volumes: protected names are never touched, living roots keep theirs, other names are ignored', () => {
  const live = new Set(rootHashes('/work/live'));
  const gone = rootHashes('/work/gone')[0];
  const names = [`cache-${live.values().next().value}`, `cache-${gone}`, `cache-${gone}-build-api`, `other-${gone}`, 'cache-nothex000000', `keepme_${gone}`];
  assert.deepEqual(orphanVolumes(names, ['cache-'], live, [], () => true), [`cache-${gone}`, `cache-${gone}-build-api`]);
  assert.deepEqual(orphanVolumes(names, ['keepme_'], live, ['KEEPME'], () => true), [], 'a protected name is never listed, even under a matching prefix');
});

test('volumes: an unknown hash alone is no proof, a foreign clone or an unreachable worktree keeps its volume (#951)', () => {
  const live = new Set(rootHashes('/work/live'));
  const foreign = `cache-${rootHashes('/other/clone/wt')[0]}`;
  const vanished = `cache-${rootHashes('/work/clone/wt')[0]}`;
  const unlabeled = `cache-${rootHashes('/work/clone/nolabel')[0]}`;
  const names = [foreign, vanished, unlabeled];
  const owned = ['/work/clone', '/work/clone/wt'];
  const dirs = new Map([[foreign, '/other/clone/wt/docker'], [vanished, '/work/clone/wt/docker']]);
  const exists = path => path === '/work/clone' || path === '/other/clone' || path === '/other/clone/wt/docker' ? true : path === '/work/clone/wt' ? false : path === '/other/clone/wt';
  assert.deepEqual(orphanVolumes(names, ['cache-'], live), [], 'without proof nothing is orphaned');
  const proof = name => goneWorkdir(dirs.get(name), owned, exists);
  assert.deepEqual(orphanVolumes(names, ['cache-'], live, [], proof), [], 'parent of the vanished dir is missing too: unreachable, kept');
  const mounted = path => path === '/work/clone/wt' || exists(path);
  assert.deepEqual(orphanVolumes(names, ['cache-'], live, [], name => goneWorkdir(dirs.get(name), owned, mounted)), [vanished], 'only the own clone with a gone dir under a reachable parent');
  assert.equal(goneWorkdir('/work/clone/wt/docker', owned, () => true), false, 'dir still exists');
  assert.equal(goneWorkdir(undefined, owned, () => false), false, 'no label');
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

test('only the head of a merged PR counts as saved, a closed but unmerged one does not', () => {
  const listing = JSON.stringify([{ headRefOid: 'aaa', mergedAt: '2026-10-01T00:00:00Z' }, { headRefOid: 'bbb', mergedAt: null }]);
  assert.deepEqual([...mergedHeads(listing)], ['aaa']);
  assert.deepEqual([...mergedHeads('not json')], []);
});

test('invalid --min-age, --jobs and an unknown --only are refused with exit 2, even with --rm', async t => {
  const dir = temporary(t, 'worktree-gc-');
  const env = isolatedGit(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { env });
  for (const args of [['--min-age', '30m'], ['--min-age', '-1'], ['--jobs', 'abc'], ['--jobs', '0'], ['--only', join(dir, 'nope')]]) {
    const result = await run(process.execPath, [script, '--cwd', dir, '--rm', ...args], { env });
    assert.equal(result.status, 2, args.join(' '));
    assert.doesNotMatch(result.stderr, /AssertionError|\sat /, 'no stack trace');
  }
});

test('an unreadable worktree list stops the run with an error, before anything is removed', async t => {
  const dir = temporary(t, 'worktree-gc-');
  mkdirSync(join(dir, '.git'));
  const result = await run(process.execPath, [script, '--cwd', dir, '--rm', '--min-age', '0'], { env: isolatedGit(dir) });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /worktree list/);
  assert.doesNotMatch(result.stderr, /AssertionError|\sat /, 'no stack trace');
});

test('an unknown option is refused with exit 2 and a usage text, --help exits 0', async () => {
  const unknown = await run(process.execPath, [script, '--rm-all']), help = await run(process.execPath, [script, '--help']);
  assert.equal(unknown.status, 2);
  assert.doesNotMatch(unknown.stderr, /ERR_PARSE_ARGS/, 'no Node error code');
  assert.equal(help.status, 0);
});
