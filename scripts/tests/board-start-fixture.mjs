import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, handoffPr } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

// A checkout with an origin that already holds the branch of issue 1, and the files the fake gh answers from.
export function startFixture(t) {
  const { checkout, run, writeIssue, env } = fixture(t);
  env.CODEX_THREAD_ID = '';
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  const origin = join(dirname(checkout), 'origin.git');
  git(dirname(checkout), 'init', '-q', '--bare', origin);
  git(checkout, 'init', '-q', '-b', 'main');
  // start commits too, so the identity lives in the checkout (a CI runner has none).
  git(checkout, 'config', 'user.name', 't');
  git(checkout, 'config', 'user.email', 't@t');
  git(checkout, 'commit', '--allow-empty', '-q', '-m', 'base');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-q', 'origin', 'main');
  const file = name => join(checkout, name);
  const text = name => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  writeFileSync(file('handoff-fixture'), '');
  writeFileSync(file('pr.json'), JSON.stringify(handoffPr({ id: 'PR7', isDraft: true, linkPages: [[]], url: 'https://github.com/test/example/pull/7' })));
  writeFileSync(file('backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0 }));
  writeFileSync(file('backlink-comments-1.json'), '[]');
  return { checkout, run, writeIssue, git, file, text, env };
}
