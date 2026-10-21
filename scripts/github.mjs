// The one door from board.mjs to GitHub: every `gh` call, the GraphQL quota logic and the Project field cache live here.
// Two variants: the real `gh` process, and a test variant that a test sets with useGhAdapter (board-worker.mjs hands in fake-gh.mjs),
// so tests never patch a Node function.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isRateLimited, quotaOf, retryAt, splitResponse, untilText } from './quota.mjs';

// Commands that sleep until the quota reset instead of failing, with the points they keep in reserve.
export const sleepers = { wait: 300, reviews: 50, handoff: 50, done: 50, 'quota-wait': 300 };

/** A quota pause that would end after the deadline: `wait` ends "still waiting" instead of sleeping through it. */
export class StillWaiting extends Error {
  constructor(resetAt) { super('still waiting'); this.resetAt = resetAt; }
}

/** The quota is used up until `resetAt`: `wait` does not sleep through it but keeps looking over REST (pausedRound). */
export class QuotaPause extends Error {
  constructor(resetAt) { super('quota pause'); this.resetAt = resetAt; }
}

let adapter; // (args, options) => stdout text, like execFileSync of `gh`; unset means the real process
export const useGhAdapter = fake => { adapter = fake; };

/**
 * `tool` is the found `gh` ({ file, env }). `github.quota`, `spent`, `calls` and `deadline` (set by the waiting commands) are read by board.mjs;
 * the account's GraphQL quota (5000 points an hour) is shared by every agent on it. Every response carries what is left and when it
 * resets in its headers (`gh api -i`, also on a refusal), so no extra request asks for it; a query reads its own cost.
 */
export function createGithub({ tool, command, projectDirectory, sleep }) {
  const github = { quota: undefined, spent: 0, calls: 0, deadline: Infinity }; // the latest quota, this run's reported cost and request count

  /** One `gh` call; options as for execFileSync (`input`, `stdio`). */
  github.run = (args, options = {}) => adapter ? adapter(args, options)
    : execFileSync(tool.file, args, { encoding: 'utf8', env: tool.env, maxBuffer: 16 << 20, ...options });

  /** Say so in one line (stderr keeps stdout for the verdict) and sleep until the reset. */
  github.sleepUntilReset = resetAt => {
    if (command === 'wait') throw new QuotaPause(resetAt);
    if (Date.parse(resetAt) > github.deadline) throw new StillWaiting(resetAt);
    console.error(`rate limited until ${untilText(resetAt)}`);
    sleep(Math.max(1, (Date.parse(resetAt) - Date.now()) / 1000 + 1));
  };

  /**
   * One GraphQL request. `tolerate` is a pattern for a failure whose partial answer is still wanted (one of several aliased mutations
   * failed): gh then exits non-zero, but the data of the others is in its output. `beforeSend` runs after pauses, on every attempt.
   */
  github.graphql = (query, variables = {}, tolerate, beforeSend) => {
    // Organization-linked Priority fields live on the issue and need this preview header.
    const args = ['api', 'graphql', '-i', '-H', 'GraphQL-Features: issue_fields', '-f',
      `query=${query.startsWith('query') ? `${query.slice(0, query.lastIndexOf('}'))} rateLimit{cost remaining resetAt}}` : query}`];
    for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
    for (let sleeps = 0; ; sleeps++) {
      if (command in sleepers && github.quota?.remaining < sleepers[command] && Date.parse(github.quota.resetAt) > Date.now()) github.sleepUntilReset(github.quota.resetAt);
      try {
        beforeSend?.();
        github.calls++;
        // stderr piped: a tolerated refusal ("already exists") is no failure, and a real one reaches the error message.
        const response = github.run(args, { stdio: 'pipe' });
        const { headers, body } = splitResponse(response);
        const { data, errors } = JSON.parse(body);
        // The body's rateLimit is what a real `{rateLimit{remaining}}` query returns (#625); the headers were seen 4400 points too high.
        const { remaining, resetAt } = data?.rateLimit ?? {};
        github.quota = (Number.isFinite(remaining) && resetAt ? { remaining, resetAt } : quotaOf(headers)) ?? github.quota;
        github.spent += data?.rateLimit?.cost ?? (query.startsWith('mutation') ? 1 : 0);
        if (process.env.BOARD_TRACE) console.error(`gql ${data?.rateLimit?.cost ?? (query.startsWith('mutation') ? '~1' : 0)} ${query.replace(/\s+/g, ' ').slice(0, 90)}`);
        if (errors?.length) {
          const message = errors.map(({ type, message }) => `${type ?? ''} ${message ?? ''}`).join('\n').trim();
          if (!(tolerate?.test(message) && data)) throw Object.assign(new Error(message), { stdout: response, stderr: message });
        }
        return data;
      } catch (error) {
        const text = `${error.stderr}${error.stdout}`, { headers, body } = splitResponse(error.stdout);
        if (tolerate?.test(text)) {
          let partial;
          try { partial = JSON.parse(body).data; } catch { /* no usable answer: the error below */ }
          if (partial) return partial;
        }
        if (!isRateLimited(text)) throw error;
        github.quota = quotaOf(headers) ?? github.quota;
        // A primary refusal whose own headers show free quota is stale (the window reset meanwhile): ask again now, never wait for a reset time.
        if (!/secondary rate limit/i.test(text) && github.quota?.remaining > 0 && quotaOf(headers)) {
          assert.ok(sleeps < 3, `GitHub keeps refusing although its headers report ${github.quota.remaining} points left; run ${command} again later`);
          continue;
        }
        // The refusal names its own reset; without headers, a minute from now.
        const resetAt = retryAt(text, sleeps, () => quotaOf(headers)?.resetAt ?? new Date(Date.now() + 60_000).toISOString(), Date.now(), headers);
        assert.ok(command in sleepers && sleeps < 3, `The GitHub GraphQL quota is used up until ${untilText(resetAt)}; run ${command} again after that`);
        github.sleepUntilReset(resetAt);
      }
    }
  };

  github.rest = path => JSON.parse(github.run(['api', path], { stdio: 'pipe' }));

  /** Every page, so an early bot summary on a long PR is never cut off. */
  github.restAll = (path, expected) => {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = github.rest(`${path}?per_page=100&page=${page}`);
      assert.ok(Array.isArray(batch) && batch.length <= 100, 'Unreadable REST page');
      items.push(...batch);
      assert.ok(expected === undefined || items.length <= expected, 'More comments than declared; retry the read');
      if (batch.length < 100) return items;
    }
  };

  // Field and option ids of the Project change rarely: kept in the clone's Git directory (shared by its worktrees) and read again only when
  // a name or option is missing from them or a write with them fails. One read costs a point; every run used to pay it.
  const fieldsFile = () => {
    assert.notEqual(process.env.BOARD_FIELD_CACHE, '0', 'field cache switched off'); // the board tests change definitions between calls
    // Read from the files, not `git rev-parse`: a worktree's `.git` is a file naming its directory, whose `commondir` names the shared one.
    let dir = join(projectDirectory, '.git');
    if (statSync(dir).isFile()) dir = resolve(projectDirectory, readFileSync(dir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    if (existsSync(join(dir, 'commondir'))) dir = resolve(dir, readFileSync(join(dir, 'commondir'), 'utf8').trim());
    return join(dir, 'board-project-fields.json');
  };
  github.dropFieldsCache = () => { if (process.env.BOARD_FIELD_CACHE !== '0') rmSync(fieldsFile(), { force: true }); };
  /** The single-select fields of the Project, from the cache or one query. */
  github.loadFields = projectId => {
    try {
      const cached = JSON.parse(readFileSync(fieldsFile(), 'utf8'));
      if (cached.project === projectId && Array.isArray(cached.fields)) return { fields: cached.fields, cached: true };
    } catch { /* no usable cache: read the definitions */ }
    const fields = github.graphql(`query($id:ID!){node(id:$id){...on ProjectV2{fields(first:100){nodes{...on ProjectV2SingleSelectField{
      id name options{id name} issueField{...on IssueFieldSingleSelect{id options{id name}}}}}}}}}`, { id: projectId })
      .node.fields.nodes.filter(candidate => candidate.name && candidate.options);
    try { writeFileSync(fieldsFile(), JSON.stringify({ project: projectId, fields })); } catch { /* read-only Git directory: no cache */ }
    return { fields, cached: false };
  };

  return github;
}
