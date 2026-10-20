import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, test } from './board-fixture.mjs';
import { isolatedGit } from './fixtures.mjs';

test('ready --local takes the head of the checkout and still needs the PR to show exactly it', t => {
  const { checkout, run } = fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: checkout, encoding: 'utf8', env: isolatedGit(dirname(checkout)) }).trim();
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'pushed');
  const PUSHED = git('rev-parse', 'HEAD');
  const quick = ['--attempts', '2', '--interval', '0.01'];
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean).length : 0;
  const prepare = changes => {
    for (const file of ['mutations', 'pr-rest-reads.json', 'ready-noop', 'fail']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ id: 'PR7', number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false,
      headRefOid: PUSHED, headRepository: { nameWithOwner: 'test/example' }, ...changes }));
  };

  // --local replaces the commit id, so a word after it has no meaning: refused, nothing marked ready.
  prepare();
  assert.equal(run('ready', '7', '--local', 'extra', ...quick).status, 2);
  assert.equal(mutations(), 0);

  let result = run('ready', '7', '--local', ...quick);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^READY #7 head ${PUSHED}`, 'm'), 'The head came from the checkout');
  assert.equal(mutations(), 1);

  // A commit that exists only here is a head the PR does not show: refused, as a mistyped id would be.
  git('commit', '--allow-empty', '-q', '-m', 'not pushed');
  prepare();
  result = run('ready', '7', '--local', ...quick);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED$/m);
  assert.equal(mutations(), 0, 'nothing is written for a head the PR does not show');

  prepare({ isDraft: false });
  assert.equal(run('ready', '7', '--local', ...quick).status, 1, 'An already ready PR with another head is refused too');
  assert.equal(mutations(), 0);
});

test('ready marks a Draft PR ready only for the expected pushed commit and never trusts stale metadata', t => {
  const { checkout, run } = fixture(t);
  const NEW = 'c0ffee'.repeat(6) + 'abcd', OLD = 'decade'.repeat(6) + 'abcd', OTHER = 'facade'.repeat(6) + 'abcd';
  const quick = ['--attempts', '3', '--interval', '0.01'];
  const mutations = () => existsSync(join(checkout, 'mutations')) ? readFileSync(join(checkout, 'mutations'), 'utf8').split('\n').filter(Boolean).length : 0;
  const prepare = (changes = {}, reads) => {
    for (const file of ['mutations', 'pr-rest-reads.json', 'ready-noop', 'fail']) rmSync(join(checkout, file), { force: true });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ id: 'PR7', number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false,
      headRefOid: NEW, headRepository: { nameWithOwner: 'test/example' }, ...changes }));
    if (reads) writeFileSync(join(checkout, 'pr-rest-reads.json'), JSON.stringify(reads));
  };
  // The verdict and the write count carry the behavior; the diagnostic wording is free to change.
  const refused = (changes, reads, label) => {
    prepare(changes, reads);
    const result = run('ready', '7', NEW, ...quick);
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^FAILED$/m, label);
    assert.equal(mutations(), 0, `${label}: nothing is written`);
  };

  prepare();
  let result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^READY /m);
  assert.equal(mutations(), 1, 'Exactly one Ready mutation');

  prepare({ headRepository: { nameWithOwner: 'Test/Example' } });
  assert.equal(run('ready', '7', NEW, ...quick).status, 0, 'Repository names compare case-insensitively');
  prepare({ headRefOid: OLD }, [{ headRefOid: OLD }]);
  for (const options of [['--interval', 'Infinity'], ['--interval', '1e308'], ['--interval', '-1'], ['--attempts', '0'], ['--attempts', '1.5'],
    ['--attempts', '101'], ['--attempts', '100', '--interval', '100'], ['--attempts', '100', '--interval', '18'],
    ['--attempts', '61', '--interval', '15']]) {
    assert.equal(run('ready', '7', NEW, ...options).status, 2, `${options.join(' ')} could wait without end and is rejected up front`);
  }
  assert.equal(mutations(), 0);

  const short = run('ready', '7', NEW.slice(0, 6), ...quick);
  assert.equal(short.status, 2, 'A commit id under 7 characters is rejected');
  assert.notEqual(short.stderr, run('ready', 'x', NEW).stderr, 'The refusal says more than the general usage line');
  assert.equal(mutations(), 0);

  prepare();
  assert.equal(run('ready', '7', NEW, '--attempts', '60', '--interval', '15').status, 0, 'Both waits together exactly at the half-hour cap are allowed');

  prepare({ headRefOid: OLD }, [{ headRefOid: OLD }, { headRefOid: NEW }]);
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 0, 'Metadata that catches up after a push is waited for: ' + result.stdout + result.stderr);
  assert.equal(mutations(), 1);

  refused({ headRefOid: OLD }, [{ headRefOid: OLD }], 'A head that stays old');
  refused({ isCrossRepository: true }, undefined, 'A fork branch');
  refused({ headRepository: { nameWithOwner: 'test/other' } }, undefined, 'Another repository');
  refused({ state: 'CLOSED' }, undefined, 'A closed PR');
  refused({ isDraft: false, headRefOid: OTHER }, undefined, 'Ready with another head');
  refused({}, [{ headRefOid: NEW }, { headRefOid: OTHER }], 'A head that changes before the mutation');

  prepare({ isDraft: false });
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 0, 'Already ready for the expected head is a success without a write');
  assert.equal(mutations(), 0);

  prepare();
  writeFileSync(join(checkout, 'fail'), '');
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 2, 'An API error is ERROR, never a guess');
  assert.match(result.stdout, /^ERROR$/m);
  assert.equal(mutations(), 0);

  prepare();
  writeFileSync(join(checkout, 'ready-noop'), '');
  result = run('ready', '7', NEW, ...quick);
  assert.equal(result.status, 2, 'A write without a matching read-back is no success');
  assert.equal(mutations(), 1, 'The mutation is not repeated blindly');

  assert.equal(run('ready', '7', 'not-a-sha').status, 2, 'Only a commit SHA is accepted');
  const missing = run('ready', '7');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /commit id of 7 to 40 characters.*or --local/, 'A missing SHA names the way out, not just the usage line');

  // The 7-character form git log shows acts like the full id; that of another commit is still refused.
  prepare();
  result = run('ready', '7', NEW.slice(0, 7), ...quick);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(mutations(), 1);
  prepare();
  assert.equal(run('ready', '7', OLD.slice(0, 7), ...quick).status, 1, 'A short id of another commit is refused');
  assert.equal(mutations(), 0);
});

test('ready refuses an unknown flag or extra word before any write', t => {
  fixture(t).refusesUnknownFlag('ready', '7', 'a'.repeat(40));
});
