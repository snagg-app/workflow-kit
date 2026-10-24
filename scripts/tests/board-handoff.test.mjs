import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handoffFixture, handoffPr, issue, predecessor, test } from './board-fixture.mjs';

test('handoff diagnoses draft and unreadable draft state before waiting for CI', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  const commit = handoffPr().commits.nodes[0].commit;
  for (const checks of [[], [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS' }]]) {
    for (const isDraft of [true, null, undefined, false]) {
      const pr = handoffPr({ isDraft, commits: { nodes: [{ commit: {
        ...commit, statusCheckRollup: { contexts: { totalCount: checks.length, nodes: checks } },
      } }] } });
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr));
      const result = run('handoff', '1', '7');
      const expected = isDraft === true ? 1 : isDraft === false ? 3 : 2;
      assert.equal(result.status, expected, result.stdout + result.stderr);
      if (isDraft === true) {
        assert.match(result.stdout, /^FAILED$/m);
        assert.match(result.stdout, /^blocker:/m);
        assert.doesNotMatch(result.stdout, /WAITING/);
      } else if (isDraft === false) {
        assert.match(result.stdout, /WAITING/);
      } else {
        assert.match(result.stdout, /^ERROR$/m);
      }
      assert.equal(existsSync(join(checkout, 'mutations')), false, 'Draft or incomplete CI never writes status');
    }
  }
});


test('handoff rejects drafts before unavailable review details', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'fail-rest'), '');
  const commit = handoffPr().commits.nodes[0].commit;
  for (const checks of [[], [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS' }]]) {
    for (const isDraft of [true, null, undefined, false]) {
      writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ isDraft, commits: { nodes: [{ commit: {
        ...commit, statusCheckRollup: { contexts: { totalCount: checks.length, nodes: checks } },
      } }] } })));
      const result = run('handoff', '1', '7');
      assert.equal(result.status, isDraft === true ? 1 : 2, result.stdout + result.stderr);
      assert.match(result.stdout, isDraft === true ? /^FAILED$/m : /^ERROR$/m);
      assert.doesNotMatch(result.stdout, /^WAITING$/m);
      if (isDraft === true) assert.match(result.stdout, /^blocker:/m);
      assert.equal(existsSync(join(checkout, 'mutations')), false, 'No rejected handoff writes status');
    }
  }
});


test('handoff blocks unlinked, unsafe and unreadable delivery before writing Human review', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const mutations = join(checkout, 'mutations');
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  const ownLink = number => ({ number, state: 'OPEN', repository: { nameWithOwner: 'test/example' } });
  const pending = { ...handoffPr().commits.nodes[0].commit,
    statusCheckRollup: { contexts: { totalCount: 1, nodes: [{ __typename: 'CheckRun', name: 'CI', status: 'IN_PROGRESS' }] } } };
  const failed = { ...pending, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
    { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' },
  ] } } };
  const cases = [
    [handoffPr({ linkPages: [[]] }), ready, 1], // Text/branch refs and partial delivery do not provide the required native link.
    [handoffPr({ linkPages: [['unrelated']] }), ready, 1],
    [handoffPr({ linkPages: [['I1']], linkTotal: 2 }), ready, 2],
    [handoffPr({ linkPages: [[null]], linkTotal: 1 }), ready, 2],
    [handoffPr({ linkPages: [['I1', 'I1']] }), ready, 2],
    [handoffPr({ isDraft: true }), ready, 1],
    [handoffPr({ isDraft: null }), ready, 2],
    [handoffPr({ state: 'MERGED' }), ready, 1],
    [handoffPr({ state: 'CLOSED' }), ready, 1],
    [handoffPr({ mergeStateStatus: 'DIRTY' }), ready, 1],
    [handoffPr({ mergeStateStatus: 'UNKNOWN' }), ready, 3],
    [handoffPr({ mergeStateStatus: null }), ready, 3],
    [handoffPr({ threadPages: [[false]] }), ready, 1],
    [handoffPr({ latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] } }), ready, 1],
    [handoffPr({ commits: { nodes: [{ commit: pending }] } }), ready, 3],
    [handoffPr({ commits: { nodes: [{ commit: failed }] } }), ready, 1],
    [handoffPr(), { ...ready, assignees: { nodes: [] } }, 1],
    [handoffPr(), { ...ready, assignees: { nodes: [{ login: 'someone-else' }] } }, 1],
    [handoffPr(), { ...ready, state: 'CLOSED' }, 1],
    [handoffPr(), { ...ready, projectItems: issue('In progress').projectItems }, 1],
    [handoffPr(), { ...ready, blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } }, 1],
  ];
  for (const [pr, task, status] of cases) {
    writeIssue(task);
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr));
    const result = run('handoff', '1', '7', '--interval', '0');
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Rejected handoff never mutates status');
  }
  writeIssue(ready);
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  for (const failure of ['fail', 'fail-viewer']) {
    writeFileSync(join(checkout, failure), '');
    assert.equal(run('handoff', '1', '7').status, 2, 'An API read failure is unknown, never a handoff');
    assert.equal(existsSync(mutations), false);
    rmSync(join(checkout, failure));
  }
  const invalidCurrentLinks = [
    { totalCount: 2, nodes: [ownLink(7), ownLink(8)] },
    { totalCount: 2, nodes: [ownLink(7)] },
    undefined,
  ];
  for (const links of invalidCurrentLinks) {
    const task = { ...ready };
    if (links) task.closedByPullRequestsReferences = links;
    else delete task.closedByPullRequestsReferences;
    writeIssue(task);
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(existsSync(mutations), false, 'Ambiguous or incomplete own PR links never write Human review');
  }
  assert.equal(run('handoff', '1', '--oops').status, 2, 'Option-like PR arguments are rejected');
  writeIssue({ ...ready, closedByPullRequestsReferences: { totalCount: 3, nodes: [ownLink(7),
    { number: 6, state: 'CLOSED', repository: { nameWithOwner: 'test/example' } },
    { number: 5, state: 'MERGED', repository: { nameWithOwner: 'test/example' } }] } });
  writeFileSync(join(checkout, 'quota-left'), '4999');
  for (const baseRefName of ['main', 'release/0.1.1']) {
    writeFileSync(join(checkout, 'handoff-fixture'), '');
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ baseRefName,
      linkPages: [Array.from({ length: 100 }, (_, index) => 'other-' + index), ['I1']] })));
    const result = run('handoff', '1', '7');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /HANDOFF #1 PR #7 head abcdef1234/);
    assert.match(result.stderr, /^quota: \d+ left, [1-9]\d* reported GraphQL wrapper points, [1-9]\d* wrapper calls, resets .+$/m);
    assert.equal(readFileSync(join(checkout, 'stored'), 'utf8'), 'Human review');
  }
});

test('handoff blocks a PR text that closes a spec with a keyword, and lets "Refs" and ordinary issues through', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'backlink-5.json'), JSON.stringify({ number: 5, labels: [{ name: 'spec' }] }));
  writeFileSync(join(checkout, 'backlink-6.json'), JSON.stringify({ number: 6, labels: [{ name: 'bug' }] }));
  const handoff = body => {
    writeFileSync(join(checkout, 'handoff-fixture'), '');
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ body })));
    return run('handoff', '1', '7', '--interval', '0');
  };

  for (const body of ['Closes #5', 'fixes: test/example#5 and more', 'Resolved #6, closed #5']) {
    const blocked = handoff(body);
    assert.equal(blocked.status, 1, `${body}: ${blocked.stdout}${blocked.stderr}`);
    assert.match(blocked.stdout, /^blocker: BLOCKED: #5 is a spec .*write "Refs #5" instead/m, body);
    assert.equal(existsSync(join(checkout, 'stored')), false, `${body}: Human review is not written`);
  }
  for (const body of ['Refs #5', 'Closes #6', 'Closes someone/else#5']) {
    const passed = handoff(body);
    assert.equal(passed.status, 0, `${body}: ${passed.stdout}${passed.stderr}`);
  }
});

test('handoff passes a Refs PR beside the one closing PR through its own gate and leaves the issue status alone (#398)', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  const link = (number, state = 'OPEN') => ({ number, state, repository: { nameWithOwner: 'test/example' } });
  const links = (...nodes) => ({ closedByPullRequestsReferences: { totalCount: nodes.length, nodes } });
  const attempt = (task, pr = handoffPr({ linkPages: [[]] })) => {
    writeIssue({ ...ready, ...task });
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(pr));
    return run('handoff', '1', '7', '--interval', '0');
  };

  const partial = attempt(links(link(8)));
  assert.equal(partial.status, 0, partial.stdout + partial.stderr);
  assert.match(partial.stdout, /HANDOFF #1 PR #7 head abcdef1234 \(partial PR/);
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'The issue status is not written while PR 8 is open');

  // --refs does the same for a PR that only names the issue, with no native link at all (#510); without it the missing link blocks.
  assert.match(attempt({}).stdout, /PR #7 is not natively linked to issue #1/);
  const refs = run('handoff', '1', '7', '--refs', '--interval', '0');
  assert.equal(refs.status, 0, refs.stdout + refs.stderr);
  assert.match(refs.stdout, /HANDOFF #1 PR #7 head abcdef1234 \(partial PR/);
  assert.equal(existsSync(join(checkout, 'mutations')), false, 'The issue status is not written for a Refs PR');

  // The PR gate still holds for the partial PR.
  assert.equal(attempt(links(link(8)), handoffPr({ linkPages: [[]], mergeStateStatus: 'DIRTY' })).status, 1);
  writeFileSync(join(checkout, 'issues-comments.json'), '[]');
  const uncommented = attempt(links(link(8)));
  assert.equal(uncommented.status, 1);
  assert.match(uncommented.stdout, /kein Übergabe-Kommentar/);

  // Two open closing PRs stay unknown, and so does a PR that nothing links.
  const two = attempt(links(link(8), link(9)));
  assert.equal(two.status, 2, two.stdout + two.stderr);
  assert.match(two.stdout, /multiple open PRs/);
  assert.equal(attempt(links(link(8, 'MERGED'))).status, 2);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
});


test('handoff rechecks issue prerequisites after review and link reads, before mutation', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const changes = [
    { ...ready, state: 'CLOSED' },
    { ...ready, assignees: { nodes: [] } },
    { ...ready, assignees: { nodes: [{ login: 'someone-else' }] } },
    { ...ready, projectItems: issue('In progress').projectItems },
    { ...ready, blockedBy: { totalCount: 1, nodes: [predecessor('OPEN', null)] } },
    { ...ready, blockedBy: { totalCount: 1, nodes: [] } },
    { ...ready, closedByPullRequestsReferences: { totalCount: 2, nodes: [
      { number: 7, state: 'OPEN', repository: { nameWithOwner: 'test/example' } },
    ] } },
  ];
  for (const changed of changes) {
    writeIssue(ready);
    writeFileSync(join(checkout, 'changed-issue.json'), JSON.stringify(changed));
    const result = run('handoff', '1', '7');
    assert.ok([1, 2].includes(result.status), result.stdout + result.stderr);
    assert.equal(existsSync(join(checkout, 'mutations')), false, 'A newer issue state must not be overwritten');
    assert.doesNotMatch(result.stdout, /HANDOFF #1/);
  }
});


test('handoff rechecks PR gates before mutation and rejects changed review proof', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const ready = { ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } };
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  const commit = handoffPr().commits.nodes[0].commit;
  const changedHead = 'new-head';
  const changes = [
    handoffPr({ headRefOid: changedHead, commits: { nodes: [{ commit: { ...commit, oid: changedHead } }] } }),
    handoffPr({ state: 'CLOSED' }),
    handoffPr({ state: 'MERGED' }),
    handoffPr({ isDraft: true }),
    handoffPr({ mergeStateStatus: 'UNKNOWN' }),
    handoffPr({ mergeStateStatus: 'DIRTY' }),
    handoffPr({ latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] } }),
    handoffPr({ threadPages: [[false]] }),
    handoffPr({ linkPages: [[]] }),
    ...['IN_PROGRESS', 'COMPLETED'].map(status => handoffPr({ commits: { nodes: [{ commit: {
      ...commit, statusCheckRollup: { contexts: { totalCount: 1, nodes: [
        { __typename: 'CheckRun', name: 'CI', status, conclusion: 'FAILURE' },
      ] } },
    } }] } })),
  ];
  for (const prAfterLinks of changes) {
    writeIssue(ready);
    writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ prAfterLinks })));
    const result = run('handoff', '1', '7', '--interval', '0');
    assert.ok([1, 2, 3].includes(result.status), result.stdout + result.stderr);
    assert.equal(existsSync(join(checkout, 'mutations')), false, 'Changed PR proof must never write Human review');
    assert.doesNotMatch(result.stdout, /HANDOFF #1/);
  }
});


test('handoff reports a failed status read-back instead of claiming delivery', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'lost'), 'Ready');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr()));
  const result = run('handoff', '1', '7');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /HANDOFF #1/);
});


test('handoff names every missing point at once, issue side and PR side together', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ linkPages: [[]] })));
  writeFileSync(join(checkout, 'issues-comments.json'), JSON.stringify([]));
  const result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const part of [/not assigned/, /kein Übergabe-Kommentar/, /not natively linked/]) assert.match(result.stdout, part);
  assert.equal(existsSync(join(checkout, 'mutations')), false);
});


test('handoff dismisses a stale change request of an optional reviewer, but no other', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  const config = join(checkout, '.github/workflow-project.json'), plain = readFileSync(config, 'utf8');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(plain), optionalReviewers: ['coderabbitai'] }));
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  const asked = author => handoffPr({ latestOpinionatedReviews: { totalCount: 1, nodes: [{ state: 'CHANGES_REQUESTED', author: { login: author } }] } });
  const review = (id, login, state) => ({ id, user: { login: `${login}[bot]`, type: 'Bot' }, state, commit_id: 'old', submitted_at: '2026-10-07T00:00:00Z', html_url: 'r' });
  writeFileSync(join(checkout, 'pulls-reviews.json'), JSON.stringify([review(5, 'coderabbitai', 'COMMENTED'), review(6, 'coderabbitai', 'CHANGES_REQUESTED'), review(7, 'other', 'CHANGES_REQUESTED'), review(8, 'coderabbitai', 'COMMENTED')]));
  const calls = join(checkout, 'calls');
  // An open thread keeps the optional reviewer a blocker; nothing is dismissed.
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify({ ...asked('coderabbitai'), threadPages: [[false]] }));
  let result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker: changes requested by coderabbitai$/m);
  assert.equal(existsSync(calls), false, 'An open thread never dismisses');
  // A reviewer that is not optional keeps blocking, even with every thread resolved.
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(asked('other')));
  result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker: changes requested by other$/m);
  assert.equal(existsSync(calls), false, 'A non-optional reviewer is never dismissed');
  // All threads resolved: the change request is dismissed (its own review, naming the head) and handoff goes through.
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(asked('coderabbitai')));
  result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(calls, 'utf8'), /^dismiss 6 .*abcdef1/);
});


test('handoff reads an undetermined merge state again before it gives up', t => {
  const { checkout, run, writeIssue, queries, restOverlays } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ mergeStateStatus: 'UNKNOWN' })));
  // The first read says UNKNOWN, the retry (REST, #882: no GraphQL query) says CLEAN.
  restOverlays([{ mergeStateStatus: 'CLEAN' }]);
  const result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /HANDOFF #1 PR #7/);
  assert.deepEqual(queries().filter(query => query.includes('headRefOid mergeStateStatus')), [], 'the retry asks REST, no GraphQL query (#882)');
  assert.equal(run('handoff', '1', '7', '--interval', 'x').status, 2, 'A bad interval is a usage error');
});


test('handoff lists merge conflicts that GitHub reports only after an undetermined state', t => {
  const { checkout, run, writeIssue, restOverlays } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ mergeStateStatus: 'UNKNOWN' })));
  restOverlays([{ mergeStateStatus: 'DIRTY' }]);
  const result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /blocker: merge conflicts/);
  assert.doesNotMatch(result.stdout, /WAITING|not determined/);
});

test('handoff blocks a conflict of a lower stack layer and names the order that fixes it (#412)', t => {
  const { checkout, run, writeIssue } = handoffFixture(t);
  writeIssue({ ...issue('Automated review'), assignees: { nodes: [{ login: 'worker' }] } });
  writeFileSync(join(checkout, 'handoff-fixture'), '');
  writeFileSync(join(checkout, 'pr.json'), JSON.stringify(handoffPr({ mergeStateStatus: 'DIRTY', headRefName: 'claude/1-topic' })));
  let result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 1, 'no PR builds on it: the top layer');
  assert.match(result.stdout, /^blocker: merge conflicts$/m);
  writeFileSync(join(checkout, 'dependents.json'), JSON.stringify([{ number: 8, base: { ref: 'claude/1-topic' } }]));
  result = run('handoff', '1', '7', '--interval', '0');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^blocker: merge conflicts in a lower stack layer.*then each layer into the next one up.*stack-sync/m);
});

test('handoff refuses an unknown flag before any write', t => {
  handoffFixture(t).refusesUnknownFlag('handoff', '1', '7');
});
