// The review marker must be written when the script starts through a link such as `.vendor/workflow-kit` (#1049).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
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
  const result = spawnSync(process.execPath, [join(link, 'scripts/review-marker.mjs')], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(repo, '.git/board-code-review')), 'marker file missing');
});
