// What the files of the `done` tests share (board-done*.test.mjs): the delivery checkout and the moves of PR and base.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handoffPr, issue } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

// A checkout with one commit, which the Draft PR 7 shows as its head, and the files the fake gh answers from.
export function delivery(t, fixtureOf) {
  const { checkout, run, writeIssue, env, restOverlays } = fixtureOf(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  git('init', '-q', '-b', 'work');
  git('config', 'user.name', 't'); // board.mjs commits its merge with the checkout's own identity
  git('config', 'user.email', 't@t');
  git('commit', '--allow-empty', '-q', '-m', 'pushed');
  git('init', '-q', '--bare', join(dirname(checkout), 'origin.git'));
  git('remote', 'add', 'origin', join(dirname(checkout), 'origin.git'));
  git('push', '-q', 'origin', 'work', 'work:release/0.1.1'); // the base of PR 7 is at the head: nothing to merge
  const head = git('rev-parse', 'HEAD');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  const json = name => JSON.parse(text(name));
  const pr = handoffPr({ id: 'PR7', isDraft: true, headRefName: 'work', headRefOid: head, baseRefOid: head, isCrossRepository: false, headRepository: { nameWithOwner: 'test/example' }, url: 'https://github.com/test/example/pull/7', body: 'Closes #1' });
  pr.commits.nodes[0].commit.oid = head;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('stored'), 'In progress');
  writeFileSync(file('issues-comments.json'), '[]');
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 1, body: '- [ ] first\n- [ ] moved on, see #12\n- [x] done' }));
  writeFileSync(file('backlink-comments-1.json'), JSON.stringify([{ id: 1, body: 'https://github.com/test/example/pull/7', html_url: 'u' }]));
  writeFileSync(file('result.md'), 'Alles geliefert.\n\n### Retro\n\n- Keine Funde\n');
  writeIssue({ ...issue('In progress'), assignees: { nodes: [{ login: 'worker' }] } });
  return { run, writeIssue, restOverlays, head, file, text, json, git, checkout, env };
}

// What GitHub shows of PR 7: the changes, and a head (also the one of its last commit).
export function showPr(file, json, { headRefOid, ...changes }) {
  const pr = { ...json('pr.json'), ...changes };
  if (headRefOid) pr.headRefOid = pr.commits.nodes[0].commit.oid = headRefOid;
  writeFileSync(file('pr.json'), JSON.stringify(pr));
}

// The base gets a commit that the branch lacks (files: written in it) and the branch an own commit (files: written in it).
export function moveBase(git, checkout, theirs = {}, mine = {}) {
  const commit = (files, message) => {
    for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(checkout, name)), { recursive: true }); writeFileSync(join(checkout, name), content); git('add', name); }
    git('commit', '--allow-empty', '-q', '-m', message);
  };
  git('checkout', '-q', '-b', 'side');
  commit(theirs, 'base moved');
  git('push', '-q', 'origin', 'side:release/0.1.1');
  git('checkout', '-q', 'work');
  git('branch', '-q', '-D', 'side');
  commit(mine, 'own work');
}

export function baseMergePolicy(file, json, doneBaseMerge = 'overlap') {
  writeFileSync(file('base-project.json'), JSON.stringify({ ...json('.github/workflow-project.json'), doneBaseMerge }));
}
