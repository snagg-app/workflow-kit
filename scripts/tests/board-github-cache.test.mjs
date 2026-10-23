import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub, useGhAdapter } from '../github.mjs';

test('the GitHub access keeps the last full read for every command of a run until the PR changes', () => {
  let updated = 'a';
  useGhAdapter(([, path]) => JSON.stringify(path.includes('/pulls/') ? { head: { sha: 'abc' }, updated_at: updated, state: 'open' }
    : path.includes('check-runs') ? { check_runs: [] } : path.includes('check-suites') ? { check_suites: [] } : { statuses: [] }));
  try {
    const github = createGithub({ tool: {}, projectDirectory: '.', sleep() {} });
    const marker = github.changeMarker('o/r', 7);
    assert.equal(github.recallRead(marker), undefined, 'nothing read yet');
    github.keepRead({ marker, pr: { number: 7 }, threads: [], at: Date.now() });
    assert.equal(github.recallRead(github.changeMarker('o/r', 7)).pr.number, 7);
    assert.equal(github.recallRead(marker, Date.now() + 5 * 60_000 + 1), undefined, 'a full read is repeated after five minutes');
    updated = 'b';
    assert.equal(github.recallRead(github.changeMarker('o/r', 7)), undefined, 'a changed PR is read again');
    assert.equal(github.pause(0, true), 60);
  } finally { useGhAdapter(undefined); }
});
