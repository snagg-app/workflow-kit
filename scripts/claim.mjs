// The claim format (#643, #789): "Agent: NAME, Session: ID", written by `start`, read by every board command. The one module that builds or searches claim lines.
// NAME is any agent of the agent table (agents.mjs), so a new agent needs no entry here; its session variable is `sessionEnv` there.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agents, agentNames, detectAgent } from './agents.mjs';

// `start` writes it as an issue comment (with "Basis: BRANCH"); once the first push opens the Draft PR, the PR body carries it and decides. The field may stand anywhere in a line
// (Codex wrote it at the end of a sentence), not quoted in code, and "Agent: codex" alone is the claim of an unknown session: it can never be
// the caller's, so it holds the issue until the line in the PR body is edited to the new session (a handover).
// Built on each call from the table (the table is a module-level object a test may extend); groups: 1 agent, 2 session.
const claimField = () => new RegExp(`(?<![\\w\`])Agent:[ \\t]*(${agentNames().join('|')})(?![\\w-])(?:[ \\t]*,[ \\t]*Session:[ \\t]*(\\w[\\w.-]*)(?![\\w.-]))?`, 'i');

/** The claim line `start` writes for this agent (default: the one running) and session. */
export const claimLine = (session, agent = detectAgent()) => `Agent: ${agent}, Session: ${session}`;
/** The claim in a text as { line, agent, session (undefined without one), text (the whole text, for the lines beside the claim) }, or null. */
export const claimIn = text => {
  const found = claimField().exec(text ?? '');
  return found && { line: found[0], agent: found[1], session: found[2], text: found.input };
};
export const hasClaim = text => claimField().test(text ?? '');
/** The body with its claim line replaced, or the line appended when it has none. */
export const withClaim = (body, line) => hasClaim(body) ? body.replace(claimField(), line) : `${body}\n${line}\n`;
export const claimOf = pr => claimIn(pr.body);
/** Claim comments of the issue, oldest first; a reply line without a session is no claim. ponytail: reads the comments the query holds (the newest 50 of an issue, 10 in lists). */
export const commentClaims = issue => (issue.comments?.nodes ?? []).map(comment => claimIn(comment.body)).filter(found => found?.session);

// The handoff comment's head line (#819): built by `done`, read by the handoff and stack gates; the one place that knows its format.
export const handoffHeadLine = head => `Head: ${head.slice(0, 7)}`;
export const hasHandoffHead = (text, head) => new RegExp(`^Head:\\s*${head.slice(0, 7)}`, 'im').test(text ?? '');
/** A comment that starts with the agent's reply line (a session is not needed). */
export const isReply = text => new RegExp(`^Agent:[ \\t]*(${agentNames().join('|')})\\b`, 'im').test(text ?? '');

/**
 * The own session: `--session` (`explicit`), else the variable of an agent that only its own session sets (CODEX_THREAD_ID), else the session an agent's `sessionFromDirectory` finds in the working directory,
 * else the variable of the other agents (CLAUDE_CODE_SESSION_ID: the session itself, not a subagent).
 */
export function ownSession(explicit, env = process.env, cwd = process.cwd(), recorded = undefined) {
  const fromEnv = names => names.map(name => env[agents[name].sessionEnv]).find(Boolean);
  const fromDirectory = dir => agentNames().map(name => agents[name].sessionFromDirectory?.exec(dir)?.[1]).find(Boolean);
  const marked = agentNames().filter(name => agents[name].detectEnv);
  return explicit ?? fromEnv(marked) ?? recorded ?? fromDirectory(cwd) ?? fromEnv(agentNames().filter(name => !marked.includes(name)));
}

// #973: `start --session X` records X in the git dir of its worktree, so `done` (which has no --session) and every later command take the session of `start`, not the
// variable a subagent inherits from its parent. The git dir is per worktree; a new `start` in the same worktree overwrites it.
const sessionFile = directory => {
  const dot = join(directory, '.git');
  let gitDir = dot;
  // a worktree's .git is a file naming its git dir; reading a directory fails with EISDIR (no stat before the read: a race)
  try { gitDir = resolve(directory, /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))[1].trim()); } catch (error) { if (error.code !== 'EISDIR') throw error; }
  return join(gitDir, 'workflow-kit-session');
};
/** The session `start` recorded in this worktree, or undefined (no record, no git). */
export function recordedSession(directory) {
  try { return readFileSync(sessionFile(directory), 'utf8').trim() || undefined; } catch { return undefined; }
}
export const recordSession = (directory, session) => writeFileSync(sessionFile(directory), `${session}\n`);
