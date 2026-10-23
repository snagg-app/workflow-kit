import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, predecessor, test } from './board-fixture.mjs';

test('next reads PR feedback by actual unique ids instead of multiplying every search slot', t => {
  const { checkout, run, queries } = fixture(t);
  const pr = { id: 'PR1', number: 101, state: 'OPEN', body: 'Agent: codex, Session: S1', repository: { nameWithOwner: 'test/example' },
    comments: { nodes: [{ createdAt: '2026-10-13T10:00:00Z', url: 'https://example.test/feedback', body: '@worker please fix' }] }, reviews: { nodes: [] } };
  const row = number => ({ ...issue('Human review'), number, issueFieldValues: { nodes: [] }, closedByPullRequestsReferences: { totalCount: 1, nodes: [pr] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([row(1), row(2)]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /https:\/\/example.test\/feedback/, 'PR feedback remains visible');
  const sent = queries(), searches = sent.filter(query => query.includes('search('));
  assert.ok(searches.every(query => !query.includes('reviews(last:5)')), 'PR comments/reviews are not nested under 30 issues times 10 PRs');
  assert.equal(sent.filter(query => query.includes('nodes(ids:["PR1"])') && query.includes('...on PullRequest')).length, 1, 'One read per actual unique PR');
  writeFileSync(join(checkout, 'pr-feedback-unreadable'), '');
  assert.notEqual(run('next').status, 0, 'Unreadable feedback must never become an empty result');
});

test('next batches feedback beyond 100 actual PRs without losing a later mention', t => {
  const { checkout, run, queries } = fixture(t);
  const rows = Array.from({ length: 11 }, (_, index) => ({ ...issue('Human review'), number: index + 1, issueFieldValues: { nodes: [] },
    closedByPullRequestsReferences: { totalCount: 10, nodes: Array.from({ length: 10 }, (_, prIndex) => ({
      id: `PR${index * 10 + prIndex}`, number: index * 10 + prIndex + 100, state: 'OPEN', body: '', repository: { nameWithOwner: 'test/example' },
      comments: { nodes: index === 10 && prIndex === 9 ? [{ createdAt: '2026-10-13T10:00:00Z', url: 'https://example.test/last', body: '@worker fix' }] : [] }, reviews: { nodes: [] },
    })) } }));
  writeFileSync(join(checkout, 'search.json'), JSON.stringify(rows));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /https:\/\/example.test\/last/);
  const batches = queries().filter(query => query.includes('...on PullRequest')).map(query => JSON.parse(/nodes\(ids:(\[[^\]]*\])/.exec(query)[1]));
  assert.deepEqual(batches.map(batch => batch.length), [100, 10]);
  assert.equal(new Set(batches.flat()).size, 110);
});

test('next rejects null PRs before filtering and reads no feedback for closed PRs', t => {
  const { checkout, run, queries } = fixture(t);
  const list = prs => writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Human review'), issueFieldValues: { nodes: [] },
    closedByPullRequestsReferences: { totalCount: prs.length, nodes: prs } }]));
  list([null]);
  const invalid = run('next');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /PR feedback ids are unreadable/);
  queries();
  list([{ id: 'PRX', state: 'UNKNOWN' }]);
  assert.match(run('next').stderr, /PR feedback states are unreadable/, 'Unknown state must not be silently treated as closed');
  queries();
  list(['CLOSED', 'MERGED'].map((state, index) => ({ id: `PR${index}`, number: index + 100, state, body: '', repository: { nameWithOwner: 'test/example' } })));
  writeFileSync(join(checkout, 'pr-feedback-unreadable'), '');
  const closed = run('next');
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.ok(queries().every(query => !query.includes('...on PullRequest')), 'Closed/merged PRs cause no feedback lookup');
});


test('next lists stackable Ready issues with their base PR apart from blocked ones', t => {
  const { checkout, run } = fixture(t);
  const pr = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'claude/5-base', headRefOid: 'abcdef1234' };
  const ready = (number, nodes) => ({ ...issue('Ready', nodes), number, issueFieldValues: { nodes: [] } });
  const open = prs => predecessor('OPEN', null, prs, { repository: { nameWithOwner: 'test/example' } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([ready(1, [open([pr])]), ready(2, [open([])]), ready(3, [predecessor('CLOSED', 'COMPLETED')])]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, stackable, held] = result.stdout.split('\n\n');
  assert.deepEqual(startable.match(/^#\d+/gm), ['#3']);
  assert.deepEqual(stackable.match(/^#\d+/gm), ['#1']);
  assert.ok(stackable.includes('base PR #5'), 'The base PR is named');
  assert.deepEqual(held.match(/^#\d+/gm), ['#2']);
});


test('next lists blocked and unreadable Ready issues apart from startable ones', t => {
  const { checkout, run } = fixture(t);
  const ready = (number, nodes, totalCount) => ({ ...issue('Ready', nodes, totalCount), number, issueFieldValues: { nodes: [] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([
    ready(1, [predecessor('CLOSED', 'COMPLETED')]),
    ready(2, [predecessor('OPEN', null)]),
    ready(3, [predecessor('CLOSED', 'NOT_PLANNED')]),
    ready(4, [], 1),
    { ...ready(5, []), projectItems: issue('Backlog').projectItems },
    { ...ready(6, []), body: '## Abhängigkeiten und Wiederaufnahme\n\nWartet bis: 2999-01-01T00:00Z' },
  ]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, held] = result.stdout.split('\n\n');
  assert.deepEqual(startable.match(/^#\d+/gm), ['#1']);
  assert.deepEqual(held.match(/^#\d+/gm), ['#2', '#3', '#4', '#6'], 'Every Ready issue appears; Backlog does not');
  assert.equal(held.match(/^ {2}- /gm).length, 4, 'Each held issue names its reason');
  assert.ok(held.includes('2999-01-01T00:00Z'), 'The unmet condition is named');
  writeFileSync(join(checkout, 'truncate'), '');
  assert.notEqual(run('next').status, 0, 'A capped search is never reported as the complete Ready set');
});


test('next reports a Ready issue with an open decision wait as a contradiction and does not start it (#514)', t => {
  const { checkout, run } = fixture(t);
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Ready'), number: 1, issueFieldValues: { nodes: [] }, body: 'Wartet bis: Entscheidung Milan' }]));
  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, held] = result.stdout.split('\n\n');
  assert.equal(startable.match(/^#\d+/gm), null, 'Not startable');
  assert.ok(held.startsWith('Ready but not startable') && held.includes('#1') && held.includes('decision of Milan'), held);
});


test('next reads the PRs of predecessors in one lookup, for the candidates for a stack only', t => {
  const { checkout, run, queries } = fixture(t);
  const pr = { number: 5, state: 'OPEN', isDraft: false, isCrossRepository: false, repository: { nameWithOwner: 'test/example' }, baseRefName: 'main', headRefName: 'claude/5-base', headRefOid: 'abcdef1234' };
  // As GitHub answers the search: the predecessor has an id and no PRs; they come from a lookup by id (deliveries.json).
  const bare = (id, state = 'OPEN', stateReason = null) => ({ id, number: 2, state, stateReason, repository: { nameWithOwner: 'test/example' } });
  const ready = (number, nodes) => ({ ...issue('Ready', nodes), number, issueFieldValues: { nodes: [] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([ready(1, [bare('P1')]), ready(2, [bare('P2')]), ready(3, [bare('P3', 'CLOSED', 'COMPLETED')]), ready(5, [bare('P1')])]));
  writeFileSync(join(checkout, 'deliveries.json'), JSON.stringify({ P1: { totalCount: 1, nodes: [pr] }, P2: { totalCount: 0, nodes: [] } }));

  const result = run('next');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [startable, stackable, held] = result.stdout.split('\n\n');
  assert.deepEqual([startable, stackable, held].map(part => part.match(/^#\d+/gm)), [['#3'], ['#1', '#5'], ['#2']]);
  assert.ok(stackable.includes('base PR #5'));
  const sent = queries();
  const lookups = sent.filter(query => query.includes('nodes(ids:'));
  assert.equal(lookups.length, 1, 'One lookup for every candidate, also when two issues share a predecessor');
  assert.equal(sent.length, 4, 'Two searches, the Project fields and the lookup');
  assert.ok(lookups[0].includes('nodes(ids:["P1","P2"])'), 'Only the open predecessors of the candidates');
  assert.ok(sent.filter(query => query.includes('search(')).every(query => !query.includes('includeClosedPrs')), 'The search does not ask for the PRs of predecessors');

  writeFileSync(join(checkout, 'search.json'), JSON.stringify([ready(3, [bare('P3', 'CLOSED', 'COMPLETED')]), ready(4, [])]));
  assert.equal(run('next').status, 0);
  assert.ok(queries().every(query => !query.includes('nodes(ids:')), 'Without a candidate there is no lookup');
});


test('next lists the own unfinished work, then abandoned and conflicting work, before the Ready issues (#593)', t => {
  const { checkout, run, queries } = fixture(t);
  const hoursAgo = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  // The PR of #15 is the claim of session S1; the others name another session.
  const work = (number, status, hours, mergeStateStatus = 'CLEAN') => ({ ...issue(status), number, issueFieldValues: { nodes: [] }, updatedAt: hoursAgo(hours),
    assignees: { nodes: [{ login: 'worker' }] }, projectItems: { nodes: [{ project: { id: 'P1' }, updatedAt: hoursAgo(hours), status: { name: status } }] },
    closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: number + 100, state: 'OPEN', body: `Agent: claude, Session: ${number === 15 ? 'S1' : 'S2'}`, updatedAt: hoursAgo(hours), mergeStateStatus, repository: { nameWithOwner: 'test/example' } }] } });
  writeFileSync(join(checkout, 'search.json'), JSON.stringify([{ ...issue('Ready'), number: 10, issueFieldValues: { nodes: [] } }, work(11, 'Automated review', 8), work(12, 'Human review', 1, 'DIRTY'),
    work(13, 'Human review', 1), work(14, 'In progress', 1), work(15, 'Automated review', 1)]));

  const result = run('next', '--session', 'S1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.split('\n\n').map(part => part.match(/^#\d+/gm)), [['#15'], ['#11', '#12'], ['#10']]);
  assert.ok(queries().some(query => query.includes('closedByPullRequestsReferences(first:10){nodes{number state body ')), 'the search asks for the PR bodies, where the claims stand');
  assert.deepEqual(run('next').stdout.split('\n\n').map(part => part.match(/^#\d+/gm)), [['#11', '#12'], ['#10']], 'without a session there is no own work');
});


// workflow-kit #554: nobody noticed comments or a push-back after the handoff.
test('next lists feedback after the handoff: a comment, a push-back, a mention; a reply clears it (#593)', t => {
  const { checkout, run } = fixture(t);
  const at = minute => `2026-10-10T10:${String(minute).padStart(2, '0')}:00Z`;
  const note = (minute, body) => ({ createdAt: at(minute), url: `https://example.test/c${minute}`, body });
  const handoff = note(1, '## Übergabe\n\nHead: abcdef1');
  const row = (number, status, assignee, { issueComments = [], prComments = [], reviews = [] } = {}) => ({ ...issue(status), number, issueFieldValues: { nodes: [] },
    assignees: { nodes: [{ login: assignee }] }, comments: { nodes: issueComments },
    closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: number + 100, state: 'OPEN', body: 'Agent: claude, Session: S1', repository: { nameWithOwner: 'test/example' },
      comments: { nodes: prComments }, reviews: { nodes: reviews } }] } });
  const section = () => {
    const result = run('next', '--session', 'S1');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.startsWith('Rückmeldungen') ? result.stdout.split('\n\n')[0] : '';
  };
  const list = rows => writeFileSync(join(checkout, 'search.json'), JSON.stringify(rows));

  list([row(20, 'Human review', 'worker', { prComments: [handoff] })]);
  assert.equal(section(), '', 'a handoff alone is no feedback');
  list([row(20, 'Human review', 'worker', { prComments: [handoff, note(2, 'Please change X')] })]);
  assert.match(section(), /^#20 \[Human review\] .*1 new comment\(s\).* https:\/\/example\.test\/c2$/m, 'a comment after the handoff');
  list([row(20, 'Human review', 'worker', { prComments: [handoff], reviews: [note(3, '')] })]);
  assert.match(section(), /c3$/m, 'a review after the handoff');
  list([row(20, 'Human review', 'worker', { prComments: [handoff, note(2, 'Please change X')], issueComments: [note(4, '> Agent: claude, Session: S1 (quoted)')] })]);
  assert.match(section(), /c4$/m, 'a quoted marker is no answer');
  list([row(20, 'Human review', 'worker', { prComments: [handoff, note(2, 'Please change X')], issueComments: [note(5, 'Agent: claude, Session: S1\n\nDone')] })]);
  assert.equal(section(), '', 'a reply with the agent marker answers it');

  list([row(20, 'Automated review', 'worker', { prComments: [handoff] })]);
  assert.match(section(), /^#20 \[Automated review\] .*back in Automated review after the handoff .*c1$/m, 'a pushed-back issue');
  list([row(20, 'Automated review', 'worker', { prComments: [handoff] })]);
  assert.match(section(), /back in Automated review after the handoff .*c1$/m, 'The alias keeps feedback visible');
  list([row(20, 'Automated review', 'worker', { prComments: [handoff], issueComments: [note(5, 'Agent: claude, Session: S1\n\nOn it')] })]);
  assert.equal(section(), '', 'a reply answers the push-back');

  list([row(21, 'Human review', 'someone', { prComments: [handoff, note(2, 'ping @worker, please look'), note(3, 'no mention of @workers-union')] })]);
  assert.match(section(), /^#21 .*mentions @worker .*c2$/m, 'a mention of the login, on an issue of someone else');
  list([row(21, 'Human review', 'someone', { prComments: [note(0, 'ping @worker'), handoff] })]);
  assert.equal(section(), '', 'a mention before the last handoff is old');
  list([{ ...row(22, 'Human review', 'worker', { prComments: [handoff, note(2, 'late')] }), closedByPullRequestsReferences: { nodes: [{ state: 'OPEN', body: 'Agent: claude, Session: S9',
    repository: { nameWithOwner: 'test/example' }, comments: { nodes: [handoff, note(2, 'late')] } }] } }]);
  assert.equal(section(), '', 'the issue of another session is not mine');
});
