import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agents, detectAgent } from '../agents.mjs';
import { claimIn, claimLine, commentClaims, isReply, ownSession, withClaim } from '../claim.mjs';

// #789: a new agent is one entry in the table; its claim is written, found and its session read without another edit.
test('an agent added to the table claims and is recognised as own', () => {
  agents.gemini = { detectEnv: 'GEMINI_SESSION', sessionEnv: 'GEMINI_SESSION', sessionFromDirectory: /[\\/]gem-(\w+)(?:[\\/]|$)/ };
  try {
    const env = { GEMINI_SESSION: 'G1' };
    assert.equal(detectAgent(env), 'gemini');
    const session = ownSession(undefined, env, '/work');
    assert.equal(session, 'G1');
    assert.equal(ownSession(undefined, {}, '/x/gem-zz9'), 'zz9', 'the directory rule of the new agent');
    const line = claimLine(session, detectAgent(env));
    assert.equal(line, 'Agent: gemini, Session: G1');
    const issue = { comments: { nodes: [{ body: `Claimed.\n${line}\nBasis: main\n` }] } };
    assert.equal(commentClaims(issue).at(-1).session, session, 'check sees the claim as its own');
    assert.equal(claimIn('Closes #1\nAgent: gemini, Session: OLD\n').agent, 'gemini');
    assert.equal(withClaim('Closes #1\nAgent: gemini, Session: OLD\nMore', line), 'Closes #1\nAgent: gemini, Session: G1\nMore');
    assert.ok(isReply('Agent: gemini\n\nDone'));
  } finally { delete agents.gemini; }
  assert.equal(claimIn('Agent: gemini, Session: G1'), null, 'gone from the table, gone from the pattern');
});

test('the session comes from --session, a marked agent, the worktree, then the other agents', () => {
  const env = { CODEX_THREAD_ID: 'T1', CLAUDE_CODE_SESSION_ID: 'C1' };
  assert.equal(ownSession('S0', env, '/x'), 'S0');
  assert.equal(ownSession(undefined, env, '/x/agent-ab12'), 'T1');
  assert.equal(ownSession(undefined, { CLAUDE_CODE_SESSION_ID: 'C1' }, '/x/agent-ab12'), 'ab12');
  assert.equal(ownSession(undefined, { CLAUDE_CODE_SESSION_ID: 'C1' }, '/x'), 'C1');
  assert.equal(ownSession(undefined, {}, '/x'), undefined);
});
