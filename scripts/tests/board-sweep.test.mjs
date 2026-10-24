import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';

test('sweep writes the Automated review option for a conflicting Human-review PR (#593)', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'status-options.json'), JSON.stringify(['Human review', 'Automated review']));
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Human review'), closedByPullRequestsReferences: { totalCount: 1,
    nodes: [{ number: 70, url: 'https://github.com/test/example/pull/70', state: 'OPEN', baseRefName: 'main', mergeStateStatus: 'DIRTY', repository: { nameWithOwner: 'test/example' } }] } }]));
  const result = run('sweep');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Automated review');
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
  writeFileSync(join(checkout, 'backlink-comments-5.json'), '[]');
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
  assert.match(kept.stdout, /^clean$/m, 'a reopened issue changes nothing, so the sweep is clean (#986)');
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

test('sweep skips an issue it cannot judge, handles the rest and ends red (#949)', t => {
  const { checkout, run } = fixture(t);
  const pr = changes => ({ number: 70, url: 'https://github.com/test/example/pull/70', state: 'MERGED', merged: true, mergedAt: '2026-10-09T10:00:00Z', baseRefName: 'release/1.0', mergeStateStatus: 'UNKNOWN', repository: { nameWithOwner: 'test/example' }, ...changes });
  const row = (number, status, prs, totalCount = prs.length) => ({ ...issue(status), number, id: `I${number}`,
    projectItems: { nodes: [{ id: `PI${number}`, project: { id: 'P1' }, status: { name: status } }] }, closedByPullRequestsReferences: { totalCount, nodes: prs } });
  // Issue 1 has more linked PRs than sweep reads; issue 2 behind it is still closed.
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1, 'Human review', [pr({ merged: false, state: 'CLOSED' })], 11), row(2, 'Done', [pr()])]));
  writeFileSync(join(checkout, 'backlink-comments-2.json'), '[]');
  const result = run('sweep');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /#1 skipped: .*linked PRs/);
  assert.match(result.stdout, /^#2 closed: delivered with PR #70/m);
});

test('sweep writes the conflict comment once when the status write failed before (#986)', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'status-options.json'), JSON.stringify(['Human review', 'Automated review']));
  const url = 'https://github.com/test/example/pull/70';
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Human review'), number: 5, id: 'I5',
    projectItems: { nodes: [{ id: 'PI5', project: { id: 'P1' }, status: { name: 'Human review' } }] },
    closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 70, url, state: 'OPEN', merged: false, baseRefName: 'main', headRefOid: '1234567'.padEnd(40, '0'), mergeStateStatus: 'DIRTY', repository: { nameWithOwner: 'test/example' } }] } }]));
  writeFileSync(join(checkout, 'backlink-comments-5.json'), '[]');
  writeFileSync(join(checkout, 'status-fails'), '');
  assert.equal(run('sweep').status, 1, 'a failed status write ends red');
  const comments = () => (readFileSync(join(checkout, 'mutations'), 'utf8').match(/addComment/g) ?? []).length;
  assert.equal(comments(), 1);
  const body = `Der PR ${url} (Stand 1234567) hat Konflikte mit seiner Basis, ein Issue in Human review muss aber mergebar sein. Das Issue geht zurück auf Automated review. Konflikt lösen, dann neu übergeben (\`board.mjs done\`).`;
  writeFileSync(join(checkout, 'backlink-comments-5.json'), JSON.stringify([{ id: 1, user: { login: 'worker' }, created_at: '2026-10-09T11:00:00Z', body }]));
  assert.equal(run('sweep').status, 1);
  assert.equal(comments(), 1, 'no second conflict comment');
});

test('sweep comments again when the same PR conflicts a second time with a new head (#1001)', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'status-options.json'), JSON.stringify(['Human review', 'Automated review']));
  const url = 'https://github.com/test/example/pull/70';
  const search = headRefOid => writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Human review'), number: 5, id: 'I5',
    projectItems: { nodes: [{ id: 'PI5', project: { id: 'P1' }, status: { name: 'Human review' } }] },
    closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 70, url, state: 'OPEN', merged: false, baseRefName: 'main', headRefOid, mergeStateStatus: 'DIRTY', repository: { nameWithOwner: 'test/example' } }] } }]));
  const comments = () => (readFileSync(join(checkout, 'mutations'), 'utf8').match(/addComment/g) ?? []).length;
  writeFileSync(join(checkout, 'backlink-comments-5.json'), '[]');
  search('a'.repeat(40));
  assert.equal(run('sweep').status, 0);
  assert.equal(comments(), 1);
  // The issue went back and came again with a new head: the earlier comment must not swallow this reset.
  const body = `Der PR ${url} (Stand aaaaaaa) hat Konflikte mit seiner Basis, ein Issue in Human review muss aber mergebar sein. Das Issue geht zurück auf Automated review. Konflikt lösen, dann neu übergeben (\`board.mjs done\`).`;
  const without = body.replace(' (Stand aaaaaaa)', '');
  writeFileSync(join(checkout, 'backlink-comments-5.json'), JSON.stringify([without, body].map((text, id) => ({ id, user: { login: 'worker' }, created_at: '2026-10-09T11:00:00Z', body: text }))));
  search('b'.repeat(40));
  assert.equal(run('sweep').status, 0);
  assert.equal(comments(), 2, 'a second conflict with another head is told again');
});

test('sweep stops at the first used-up quota instead of failing every issue (#986)', t => {
  const { checkout, run } = fixture(t);
  const delivered = number => ({ ...issue('Done'), number, id: `I${number}`, closedByPullRequestsReferences: { totalCount: 1,
    nodes: [{ number: 70, url: 'u', state: 'MERGED', merged: true, mergedAt: '2026-10-09T10:00:00Z', baseRefName: 'release/1.0', repository: { nameWithOwner: 'test/example' } }] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([delivered(5), delivered(6), delivered(7)]));
  for (const number of [5, 6, 7]) writeFileSync(join(checkout, `backlink-comments-${number}.json`), '[]');
  writeFileSync(join(checkout, 'mutation-limited'), '');
  const result = run('sweep');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /quota is used up/);
  assert.equal(readFileSync(join(checkout, 'limited-hits'), 'utf8').trim().split('\n').length, 1, 'only the first issue met the quota');
});

test('sweep writes the delivered comment once when closing failed before (#949)', t => {
  const { checkout, run } = fixture(t);
  const delivered = { number: 70, url: 'u', state: 'MERGED', merged: true, mergedAt: '2026-10-09T10:00:00Z', baseRefName: 'release/1.0', repository: { nameWithOwner: 'test/example' } };
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Done'), number: 5, id: 'I5', closedByPullRequestsReferences: { totalCount: 1, nodes: [delivered] } }]));
  writeFileSync(join(checkout, 'backlink-comments-5.json'), '[]');
  writeFileSync(join(checkout, 'close-fails'), '');
  assert.equal(run('sweep').status, 1, 'a failed close ends red');
  const comments = () => (readFileSync(join(checkout, 'mutations'), 'utf8').match(/addComment/g) ?? []).length;
  assert.equal(comments(), 1);
  // The earlier run's comment is on the issue now; the next run must not write it again.
  writeFileSync(join(checkout, 'backlink-comments-5.json'), JSON.stringify([{ id: 1, user: { login: 'worker' }, created_at: '2026-10-09T11:00:00Z', body: 'Geliefert mit #70 in `release/1.0`. Der Release-PR nach `main` veröffentlicht die Version.' }]));
  assert.equal(run('sweep').status, 1);
  assert.equal(comments(), 1, 'no second delivered comment');
  rmSync(join(checkout, 'close-fails'));
  assert.equal(run('sweep').status, 0);
  assert.equal(comments(), 1);
});
