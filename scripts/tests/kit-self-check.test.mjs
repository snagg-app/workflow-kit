import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { renderReadme } from '../board-readme.mjs';
import { kitSelfCheck } from '../kit-self-check.mjs';
import { isolatedGit, temporary } from './fixtures.mjs';

const template = '# Kit\n<!-- board-commands:start -->\n<!-- board-commands:end -->\n';

// A kit-like repository: the base commit has a current README; `changes` are committed on top of it.
function repo(t, { stale = false, changes = {} } = {}) {
  const dir = temporary(t, 'kit-self-check-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env: isolatedGit(dir) });
  const put = files => { for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); } };
  git('init', '-q', '-b', 'main');
  put({ 'scripts/board-readme.mjs': '', 'README.md': renderReadme(template) });
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  put({ ...changes, ...(stale ? { 'README.md': renderReadme(template).replace('| Command |', '| Old |') } : {}) });
  git('add', '.');
  git('commit', '-q', '--allow-empty', '-m', 'work');
  return dir;
}

test('a kit change with a current README and a mapped script passes', t => {
  assert.equal(kitSelfCheck(repo(t, { changes: { 'scripts/review-marker.mjs': '', 'docs/x.md': '' } }), 'main'), null);
});

test('a stale README table is refused with the command to renew it', t => {
  assert.match(kitSelfCheck(repo(t, { stale: true }), 'main'), /node scripts\/board-readme\.mjs/);
});

test('a new script without a row in affected-tests.mjs is refused and named; a new test file is not', t => {
  const message = kitSelfCheck(repo(t, { changes: { 'scripts/brand-new-tool.mjs': '', 'scripts/tests/brand-new-tool.test.mjs': '' } }), 'main');
  assert.match(message, /scripts\/brand-new-tool\.mjs/);
  assert.doesNotMatch(message, /brand-new-tool\.test/);
});

test('a project that is not the kit is not checked', t => {
  const dir = repo(t, { stale: true, changes: { 'scripts/brand-new-tool.mjs': '' } });
  execFileSync('git', ['rm', '-q', '-f', 'scripts/board-readme.mjs'], { cwd: dir, env: isolatedGit(dir) });
  assert.equal(kitSelfCheck(dir, 'main'), null);
});
