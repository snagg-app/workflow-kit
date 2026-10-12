import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';

test('sweep writes the Auto review option for a conflicting Human-review PR (#593)', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'status-options.json'), JSON.stringify(['Human review', 'Auto review']));
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Human review'), closedByPullRequestsReferences: { totalCount: 1,
    nodes: [{ number: 70, url: 'https://github.com/test/example/pull/70', state: 'OPEN', baseRefName: 'main', mergeStateStatus: 'DIRTY', repository: { nameWithOwner: 'test/example' } }] } }]));
  const result = run('sweep');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Auto review');
});

test('sweep leaves a conflicting spec untouched, including a spec beyond the first label page', t => {
  const { checkout, run } = fixture(t);
  const first = Array.from({ length: 20 }, (_, index) => ({ name: 'label-' + index }));
  const row = { ...issue('Human review'), labels: { totalCount: 21, nodes: first }, closedByPullRequestsReferences: { totalCount: 1,
    nodes: [{ number: 70, state: 'OPEN', mergeStateStatus: 'DIRTY', repository: { nameWithOwner: 'test/example' } }] } };
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row]));
  writeFileSync(join(checkout, 'issues-labels.json'), JSON.stringify([...first, { name: 'spec' }]));
  const result = run('sweep');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^clean$/m);
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'no conflict comment or status write');
});

test('sweep sends a Human-review issue with a conflicting PR back to Automated review with a comment and leaves the others alone', t => {
  const { checkout, run, queries } = fixture(t);
  const pr = (mergeStateStatus, changes) => ({ number: 70, url: 'https://github.com/test/example/pull/70', state: 'OPEN', merged: false, baseRefName: 'main', mergeStateStatus, repository: { nameWithOwner: 'test/example' }, ...changes });
  const row = (number, status, prs = []) => ({ ...issue(status), number, id: `I${number}`,
    projectItems: { nodes: [{ id: `PI${number}`, project: { id: 'P1' }, status: status && { name: status } }] }, closedByPullRequestsReferences: { totalCount: prs.length, nodes: prs } });
  const targets = () => existsSync(join(checkout, 'mutation-targets')) ? readFileSync(join(checkout, 'mutation-targets'), 'utf8').trim().split('\n') : [];
  const untouched = (label, rows) => {
    rmSync(join(checkout, 'mutations'), { force: true });
    writeFileSync(join(checkout, 'search.json'), JSON.stringify(rows));
    const result = run('sweep');
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^clean$/m, label);
    assert.equal(existsSync(join(checkout, 'mutations')), false, `${label}: nothing is written`);
  };

  // Clean PRs, PRs still being computed, other statuses, no open PR and a PR of another repository are not touched; one query reads them all.
  untouched('nothing to reset', [row(1, 'Human review', [pr('CLEAN')]), row(2, 'Human review', [pr('UNKNOWN')]), row(3, 'Human review'),
    row(4, 'Automated review', [pr('DIRTY')]), row(5, 'In progress', [pr('DIRTY')]), row(6, undefined, [pr('DIRTY')]),
    row(7, 'Human review', [pr('DIRTY', { repository: { nameWithOwner: 'someone/else' } })])]);
  assert.equal(queries().length, 1, 'A clean sweep costs one query');

  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1, 'Human review', [pr('CLEAN')]), row(2, 'Human review', [pr('DIRTY')]), row(3, 'Automated review', [pr('DIRTY')])]));
  const result = run('sweep');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^#2 reset to Automated review: PR #70 has merge conflicts$/m);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Automated review');
  assert.deepEqual(targets(), ['issue=I2', 'item=PI2'], 'Only issue 2 got its comment (first) and its status');

  // A merged PR into release/** closes its issue (comment first, then close, whatever the status); open, unmerged-closed, main and foreign PRs do not.
  const merged = (changes) => pr('UNKNOWN', { state: 'MERGED', merged: true, baseRefName: 'release/1.0', ...changes });
  untouched('nothing delivered', [row(1, 'Done', [pr('CLEAN', { baseRefName: 'release/1.0' })]), row(2, 'Done', [merged({ merged: false, state: 'CLOSED' })]),
    row(3, 'Done', [merged({ baseRefName: 'main' })]), row(4, 'Done', [merged({ repository: { nameWithOwner: 'someone/else' } })])]);
  rmSync(join(checkout, 'mutation-targets'), { force: true });
  rmSync(join(checkout, 'mutations'), { force: true });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(5, 'Human review', [merged()]), row(6, 'Done', [pr('CLEAN')])]));
  const closed = run('sweep');
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.match(closed.stdout, /^#5 closed: delivered with PR #70 in release\/1\.0$/m);
  assert.deepEqual(targets(), ['issue=I5', 'issue=I5'], 'Only issue 5 got its comment (first) and was closed');
  const mutations = readFileSync(join(checkout, 'mutations'), 'utf8');
  assert.ok(mutations.indexOf('addComment') < mutations.indexOf('closeIssue') && mutations.includes('stateReason:COMPLETED'));

  // A reopen after the merge keeps the issue open and is named; one before the merge does not count (#510).
  rmSync(join(checkout, 'mutation-targets'), { force: true });
  rmSync(join(checkout, 'mutations'), { force: true });
  const reopen = created_at => writeFileSync(join(checkout, 'events-5.json'), JSON.stringify([{ event: 'closed', created_at: '2026-10-09T12:00:00Z' }, { event: 'reopened', created_at }]));
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(5, 'Done', [merged({ mergedAt: '2026-10-09T10:00:00Z' })])]));
  reopen('2026-10-09T10:05:00Z');
  const kept = run('sweep');
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /^#5 stays open: reopened 2026-10-09T10:05:00Z after PR #70 was merged$/m);
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'a reopened issue is not written');
  reopen('2026-10-09T09:00:00Z');
  assert.match(run('sweep').stdout, /^#5 closed: delivered with PR #70/m);
  // A later release PR after the reopen delivers again (#1967).
  reopen('2026-10-09T10:05:00Z');
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(5, 'Done', [merged({ mergedAt: '2026-10-09T10:00:00Z' }), merged({ number: 71, mergedAt: '2026-10-09T11:00:00Z' })])]));
  assert.match(run('sweep').stdout, /^#5 closed: delivered with PR #71/m);
  rmSync(join(checkout, 'events-5.json'));
  rmSync(join(checkout, 'mutation-targets'), { force: true });
  rmSync(join(checkout, 'mutations'), { force: true });

  // A spec is never closed by the sweep, whatever PR was delivered (the project's own label counts too).
  rmSync(join(checkout, 'mutation-targets'), { force: true });
  untouched('a delivered spec', [{ ...row(9, 'Human review', [merged()]), labels: { nodes: [{ name: 'Spec' }] } }]);

  // A list that is cut off (more linked PRs than read, more open issues than the search returns) never ends as "clean".
  const cut = { ...row(8, 'Human review', [pr('CLEAN')]) };
  cut.closedByPullRequestsReferences.totalCount = 11;
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([cut]));
  assert.notEqual(run('sweep').status, 0, 'a truncated PR list is not clean');
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1, 'Human review', [pr('CLEAN')])]));
  writeFileSync(join(checkout, 'truncate'), '');
  assert.notEqual(run('sweep').status, 0, 'a capped search is not clean');
  rmSync(join(checkout, 'truncate'));

  assert.equal(run('sweep', 'extra').status, 2, 'A word after sweep is refused before any write');
});
