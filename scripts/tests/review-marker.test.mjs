// The review marker must be written when the script starts through a link such as `.vendor/workflow-kit` (#1049).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { copyKitScripts, isolatedGit, temporary } from './fixtures.mjs';

test('review-marker started through a directory link writes the marker', t => {
  const base = temporary(t, 'review marker link');
  const repo = join(base, 'repo'), kit = join(base, 'kit'), link = join(repo, 'vendor-link');
  mkdirSync(repo, { recursive: true });
  copyKitScripts(kit);
  const env = isolatedGit(base);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, env, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  symlinkSync(kit, link, 'junction');
  const result = spawnSync(process.execPath, [join(link, 'scripts/review-marker.mjs')], { cwd: repo, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(repo, '.git/board-code-review'), 'utf8'), git('rev-parse', 'HEAD').trim());
});

test('review-marker --cwd writes into that worktree, not the caller\'s; unknown options write nothing', t => {
  const base = temporary(t, 'review marker cwd');
  const target = join(base, 'target'), caller = join(base, 'caller'), kit = join(base, 'kit'), link = join(caller, 'vendor-link');
  mkdirSync(target, { recursive: true });
  mkdirSync(caller, { recursive: true });
  copyKitScripts(kit);
  const env = isolatedGit(base);
  for (const cwd of [target, caller]) {
    execFileSync('git', ['init', '-q'], { cwd, env });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd, env });
  }
  symlinkSync(kit, link, 'junction');
  const run = (...args) => spawnSync(process.execPath, [join(link, 'scripts/review-marker.mjs'), ...args], { cwd: caller, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(run('--help').status, 2);
  assert.equal(existsSync(join(caller, '.git/board-code-review')), false);
  const result = run('--cwd', target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(caller, '.git/board-code-review')), false);
  assert.equal(readFileSync(join(target, '.git/board-code-review'), 'utf8'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, env, encoding: 'utf8' }).trim());
  const missing = run('--cwd', join(base, 'nope'));
  assert.equal(missing.status, 2);
});

test('review-marker fails loudly when it cannot write', t => {
  const base = temporary(t, 'review marker fail');
  const repo = join(base, 'repo'), kit = join(base, 'kit');
  mkdirSync(repo, { recursive: true });
  copyKitScripts(kit);
  const env = isolatedGit(base);
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: repo, env });
  mkdirSync(join(repo, '.git/board-code-review')); // a directory where the file belongs
  const result = spawnSync(process.execPath, [join(kit, 'scripts/review-marker.mjs')], { cwd: repo, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.ok(result.stderr);
  writeFileSync(join(repo, 'tracked'), 'a');
  execFileSync('git', ['add', 'tracked'], { cwd: repo, env });
  rmSync(join(repo, '.git/board-code-review'), { recursive: true });
  const dirty = spawnSync(process.execPath, [join(kit, 'scripts/review-marker.mjs')], { cwd: repo, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(dirty.status, 1); // staged but uncommitted: no marker
  assert.equal(existsSync(join(repo, '.git/board-code-review')), false);
});
