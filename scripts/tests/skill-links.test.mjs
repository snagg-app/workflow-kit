import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { linkSkills } from '../provider-links.mjs';
import { execFileSync } from 'node:child_process';
import { isolatedGit, temporary } from './fixtures.mjs';

const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

test('Claude Code reads shared skills through links: equal copies go, changed ones move aside, own skills stay', t => {
  const root = temporary(t, 'skill links ');
  for (const skill of ['same', 'changed', 'fresh', 'impeccable']) write(join(root, '.agents/skills', skill, 'SKILL.md'), `shared ${skill}\n`);
  write(join(root, '.agents/skills/NOTICE.md'), 'notice\n');
  write(join(root, '.claude/skills/same/SKILL.md'), 'shared same\n');
  write(join(root, '.claude/skills/changed/SKILL.md'), 'my edit\n');
  write(join(root, '.claude/skills/impeccable/SKILL.md'), 'claude variant\n');
  write(join(root, '.claude/skills/NOTICE.md'), 'notice\n');
  linkSkills(root);
  for (const skill of ['same', 'changed', 'fresh']) {
    assert.ok(lstatSync(join(root, '.claude/skills', skill)).isSymbolicLink(), skill);
    assert.equal(realpathSync(join(root, '.claude/skills', skill)), realpathSync(join(root, '.agents/skills', skill)));
  }
  assert.equal(readFileSync(join(root, '.claude/skills/impeccable/SKILL.md'), 'utf8'), 'claude variant\n');
  assert.equal(existsSync(join(root, '.claude/skills/NOTICE.md')), false, 'A duplicate shared file goes');
  const [stamp] = readdirSync(join(root, '.workflow-kit/replaced'));
  assert.equal(readFileSync(join(root, '.workflow-kit/replaced', stamp, '.claude/skills/changed/SKILL.md'), 'utf8'), 'my edit\n');
  assert.deepEqual(readdirSync(join(root, '.workflow-kit/replaced', stamp, '.claude/skills')), ['changed'], 'An equal copy needs no backup');
  linkSkills(root);
  assert.deepEqual(readdirSync(join(root, '.workflow-kit/replaced')), [stamp], 'A rerun changes nothing');
});

test('after linking, git status of a project with shared skills stays clean, also in a worktree (#1034)', t => {
  const root = temporary(t, 'skill links git '), env = isolatedGit(root);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q');
  write(join(root, '.agents/skills/ponytail/SKILL.md'), 'shared\n');
  write(join(root, '.claude/skills/own/SKILL.md'), 'own\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  linkSkills(root);
  assert.ok(lstatSync(join(root, '.claude/skills/ponytail')).isSymbolicLink());
  assert.equal(git(root, 'status', '--porcelain'), '');
  linkSkills(root);
  assert.equal(git(root, 'status', '--porcelain'), '', 'A rerun adds nothing');
  assert.equal(readFileSync(join(root, '.git/info/exclude'), 'utf8').split('\n').filter(line => line === '/.claude/skills/ponytail').length, 1);
  const worktree = join(root, 'wt');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'worktree', 'add', '-q', worktree);
  writeFileSync(join(root, '.git/info/exclude'), ''); // the exclude file is shared: only the worktree's own run may add the line
  linkSkills(worktree);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
});

test('skill names with Git pattern characters are excluded literally (#1034)', t => {
  const root = temporary(t, 'skill links pattern '), env = isolatedGit(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  write(join(root, '.agents/skills/a[b]/SKILL.md'), 'shared\n');
  write(join(root, '.agents/skills/ab/SKILL.md'), 'shared\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  linkSkills(root);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('check-ignore', '.claude/skills/a[b]'), '.claude/skills/a[b]');
});
