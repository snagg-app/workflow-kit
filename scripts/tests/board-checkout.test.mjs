import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createCheckout, onBase, pushPlan, targetBranch } from '../board-checkout.mjs';
import { isolatedGit, temporary } from './fixtures.mjs';

const own = { branch: 'claude/7-x', head: 'b', upstream: '' };
const pr = { branch: 'claude/7-x', head: 'a', number: 9, sameRepo: true };
const own651 = `HEAD:refs/heads/${own.branch}`;

// One row per error case of the tickets: what the checkout looks like, what the plan must say.
const pushRows = [
  ['#646 on main: refused', { stand: { ...own, branch: 'main' } }, { refuse: /nothing is pushed to main or release/ }],
  ['#646 on release/0.1.2: refused', { stand: { ...own, branch: 'release/0.1.2' }, pr }, { refuse: /nothing is pushed to main or release/ }],
  ['#643 first push, no PR yet: own branch, upstream set', { stand: own }, { push: true, args: ['push', '-u', 'origin', own651] }],
  ['#648/#651 upstream is the base: still the own branch by name', { stand: { ...own, upstream: 'origin/main' }, pr }, { push: true, args: ['push', '-u', 'origin', own651] }],
  ['#656 head the PR does not show yet: pushed without a base merge', { stand: own, pr }, { push: true, args: ['push', '-u', 'origin', own651] }],
  ['#659 correction after an earlier done: pushed', { stand: { ...own, head: 'c' }, pr: { ...pr, head: 'b2' } }, { push: true }],
  ['head the PR already shows, no merge: nothing to push', { stand: { ...own, head: 'a' }, pr }, { push: false }],
  ['head the PR already shows, base merged: pushed', { stand: { ...own, head: 'a' }, pr, mergeNeeded: true }, { push: true }],
  ['checkout on another branch than the PR: refused', { stand: { ...own, branch: 'claude/8-y' }, pr }, { refuse: /not on the branch claude\/7-x/ }],
  ['PR branch of another repository: refused', { stand: own, pr: { ...pr, sameRepo: false } }, { refuse: /not on the branch/ }],
];
for (const [name, input, want] of pushRows) {
  test(`pushPlan: ${name}`, () => {
    const plan = pushPlan({ number: 7, ...input });
    for (const [key, value] of Object.entries(want)) {
      if (value instanceof RegExp) assert.match(plan[key], value);
      else assert.deepEqual(plan[key], value);
    }
    if (want.refuse) assert.equal(plan.push, undefined, 'a refusal pushes nothing');
  });
}

const issue = { number: 7, title: 'Git-Regeln für Branch und Push', agent: 'Claude', session: 'S1' };
const nameRows = [
  ['#657 on main: a new branch', { branch: 'main', taken: () => false }, { branch: 'claude/7-git-regeln-fur-branch-und-push', create: true }],
  ['#657 on a release branch: a new branch', { branch: 'release/0.1.2', taken: () => false }, { create: true }],
  ['detached: a new branch', { branch: '', taken: () => false }, { create: true }],
  ['own branch of the issue (a resume): stays', { branch: 'codex/7-anything', taken: () => true }, { branch: 'codex/7-anything', create: false }],
  ['branch of another issue: a new branch', { branch: 'claude/8-other', taken: () => false }, { create: true }],
  ['name taken: session, then counter', { branch: 'main', taken: name => !name.includes('S1') || name.endsWith('S1') }, { branch: 'claude/7-git-regeln-fur-branch-und-push-S1-2' }],
];
for (const [name, input, want] of nameRows) {
  test(`targetBranch: ${name}`, () => {
    const got = targetBranch({ ...issue, ...input });
    for (const [key, value] of Object.entries(want)) assert.equal(got[key], value);
  });
}

test('onBase names main and release/** only', () => {
  assert.deepEqual(['main', 'release/1', 'releases', 'x/main', ''].map(onBase), [true, true, false, false, false]);
});

// Real repositories, no GitHub.
function repos(t) {
  const root = temporary(t, 'board-checkout ');
  const env = isolatedGit(root), origin = join(root, 'origin.git'), work = join(root, 'work');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env, encoding: 'utf8' }).trim();
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'commit', '--allow-empty', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  return { git, work, origin, checkout: createCheckout({ projectDirectory: work, sleep: () => {} }) };
}

test('stand reports branch, upstream, ahead, behind and clean of a real checkout', t => {
  const { git, work, checkout } = repos(t);
  git(work, 'switch', '-c', 'claude/7-x', 'origin/main');
  assert.deepEqual({ ...checkout.stand('main'), head: undefined }, { branch: 'claude/7-x', upstream: 'origin/main', head: undefined, behind: 0, ahead: 0, clean: true });
  git(work, 'commit', '--allow-empty', '-q', '-m', 'own');
  writeFileSync(join(work, 'f'), 'x');
  git(work, 'add', 'f');
  const here = checkout.stand('main');
  assert.equal(here.ahead, 1);
  assert.equal(here.clean, false);
  assert.throws(() => checkout.stand('nope'), 'an unknown base is an error, never ahead 0');
  assert.equal(checkout.stand().ahead, undefined);
});

test('the push plan lands on the own branch even when the upstream is main (#648, #651), and never on main', t => {
  const { git, work, origin, checkout } = repos(t);
  git(work, 'switch', '-c', 'claude/7-x', 'origin/main');
  git(work, 'commit', '--allow-empty', '-q', '-m', 'own');
  const plan = pushPlan({ stand: checkout.stand('main'), number: 7 });
  checkout.git(...plan.args);
  assert.equal(git(origin, 'rev-parse', 'claude/7-x'), git(work, 'rev-parse', 'HEAD'));
  assert.notEqual(git(origin, 'rev-parse', 'main'), git(work, 'rev-parse', 'HEAD'), 'main did not move');
  git(work, 'switch', 'main');
  assert.ok(pushPlan({ stand: checkout.stand('main'), number: 7 }).refuse);
});

test('branchExists sees a local and a remote branch, hasLocalBranch only the local one', t => {
  const { git, work, checkout } = repos(t);
  git(work, 'branch', 'local-only');
  git(work, 'push', '-q', 'origin', 'main:remote-only');
  assert.deepEqual(['local-only', 'remote-only', 'none'].map(checkout.branchExists), [true, true, false]);
  assert.deepEqual(['local-only', 'remote-only'].map(checkout.hasLocalBranch), [true, false]);
});
