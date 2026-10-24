// The one door from board.mjs to GitHub: every `gh` call, the GraphQL quota logic and the Project field cache live here.
// Two variants: the real `gh` process, and a test variant that a test sets with useGhAdapter (board-worker.mjs hands in fake-gh.mjs),
// so tests never patch a Node function.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isRateLimited, quotaOf, retryAt, splitResponse, untilText, waitInterval } from './quota.mjs';

/** A quota pause that would end after the deadline: `wait` ends "still waiting" instead of sleeping through it. */
export class StillWaiting extends Error {
  constructor(resetAt) { super('still waiting'); this.resetAt = resetAt; }
}

/** The quota is used up until `resetAt`: `wait` does not sleep through it but keeps looking over REST (pausedRound). */
export class QuotaPause extends Error {
  constructor(resetAt) { super('quota pause'); this.resetAt = resetAt; }
}

/** The longest one `gh` call may take (#965); a project copy or a long paginated read stays far below it. */
const GH_TIMEOUT_MS = 120_000;

let adapter; // (args, options) => stdout text, like execFileSync of `gh`; unset means the real process
export const useGhAdapter = fake => { adapter = fake; };

/**
 * `reserve` (from the caller): the points a run keeps in reserve; with it the run sleeps until the reset instead of failing. `pauses`: a quota
 * pause is thrown as QuotaPause (the caller keeps looking over REST) instead of slept through.
 * `tool` is the found `gh` ({ file, env }). `github.quota`, `spent`, `calls` and `deadline` (set by the waiting commands) are read by board.mjs;
 * the account's GraphQL quota (5000 points an hour) is shared by every agent on it. Every response carries what is left and when it
 * resets in its headers (`gh api -i`, also on a refusal), so no extra request asks for it; a query reads its own cost.
 */
export function createGithub({ tool, reserve, pauses = false, projectDirectory, sleep, env = process.env, say = console.error, timeoutMs = GH_TIMEOUT_MS }) {
  const github = { quota: undefined, spent: 0, calls: 0, deadline: Infinity }; // the latest quota, this run's reported cost and request count

  /** One `gh` call; options as for execFileSync (`input`, `stdio`). Private: the rest of the kit uses the named operations below. */
  const run = (args, options = {}) => {
    if (adapter) return adapter(args, options);
    try {
      return execFileSync(tool.file, args, { encoding: 'utf8', env: tool.env, maxBuffer: 16 << 20, timeout: timeoutMs, ...options });
    } catch (error) {
      // A hanging call must end here, not at the driver's tool limit (maybe in the middle of a merge). Only the first two words are named: no secrets.
      if (error.code !== 'ETIMEDOUT') throw error;
      throw Object.assign(new Error(`gh ${args.slice(0, 2).join(' ')} did not answer within ${timeoutMs / 1000} s; run the command again`), { code: 'ETIMEDOUT' });
    }
  };

  /** Say so in one line (stderr keeps stdout for the verdict) and sleep until the reset. */
  github.sleepUntilReset = resetAt => {
    if (pauses) throw new QuotaPause(resetAt);
    if (Date.parse(resetAt) > github.deadline) throw new StillWaiting(resetAt);
    say(`rate limited until ${untilText(resetAt)}`);
    sleep(Math.max(1, (Date.parse(resetAt) - Date.now()) / 1000 + 1));
  };

  /**
   * One GraphQL request. `tolerate` is a pattern for a failure whose partial answer is still wanted (one of several aliased mutations
   * failed): gh then exits non-zero, but the data of the others is in its output. `beforeSend` runs after pauses, on every attempt.
   */
  /** A header quota is up to 4400 points too high (#625): in the window of a known quota it never raises it. */
  const cautious = fromHeaders => {
    const known = github.quota;
    if (!fromHeaders || !known || Date.parse(known.resetAt) <= Date.now() || Math.abs(Date.parse(known.resetAt) - Date.parse(fromHeaders.resetAt)) > 60_000) return fromHeaders;
    return { ...fromHeaders, remaining: Math.min(known.remaining, fromHeaders.remaining) };
  };
  const errorMessages = body => {
    try { return (JSON.parse(body).errors ?? []).map(({ type, message }) => `${type ?? ''} ${message ?? ''}`).join('\n'); } catch { return ''; }
  };

  github.graphql = (query, variables = {}, tolerate, beforeSend) => {
    // Organization-linked Priority fields live on the issue and need this preview header.
    const args = ['api', 'graphql', '-i', '-H', 'GraphQL-Features: issue_fields', '-f',
      `query=${query.startsWith('query') ? `${query.slice(0, query.lastIndexOf('}'))} rateLimit{cost remaining resetAt}}` : query}`];
    for (const [key, val] of Object.entries(variables)) args.push(typeof val === 'number' ? '-F' : '-f', `${key}=${val}`);
    for (let sleeps = 0; ; sleeps++) {
      if (reserve !== undefined && github.quota?.remaining < reserve && Date.parse(github.quota.resetAt) > Date.now()) github.sleepUntilReset(github.quota.resetAt);
      try {
        beforeSend?.();
        github.calls++;
        // stderr piped: a tolerated refusal ("already exists") is no failure, and a real one reaches the error message.
        const response = run(args, { stdio: 'pipe' });
        const { headers, body } = splitResponse(response);
        const { data, errors } = JSON.parse(body);
        // The body's rateLimit is what a real `{rateLimit{remaining}}` query returns (#625); the headers were seen 4400 points too high.
        const { remaining, resetAt } = data?.rateLimit ?? {};
        github.quota = (Number.isFinite(remaining) && resetAt ? { remaining, resetAt } : cautious(quotaOf(headers))) ?? github.quota;
        github.spent += data?.rateLimit?.cost ?? (query.startsWith('mutation') ? 1 : 0);
        if (env.BOARD_TRACE) say(`gql ${data?.rateLimit?.cost ?? (query.startsWith('mutation') ? '~1' : 0)} ${query.replace(/\s+/g, ' ').slice(0, 90)}`);
        if (errors?.length) {
          const message = errors.map(({ type, message }) => `${type ?? ''} ${message ?? ''}`).join('\n').trim();
          if (!(tolerate?.test(message) && data)) throw Object.assign(new Error(message), { stdout: response, stderr: message });
        }
        return data;
      } catch (error) {
        const { headers, body } = splitResponse(error.stdout);
        // Only gh's own stderr and the answer's errors[] say what failed; the echoed content (comment texts) must not.
        const text = `${error.stderr}\n${errorMessages(body)}`;
        if (tolerate?.test(`${error.stderr}${error.stdout}`)) {
          let partial;
          try { partial = JSON.parse(body).data; } catch { /* no usable answer: the error below */ }
          if (partial) return partial;
        }
        if (!isRateLimited(text)) throw error;
        github.quota = quotaOf(headers) ?? github.quota;
        // A primary refusal whose own headers show free quota is stale (the window reset meanwhile): ask again now, never wait for a reset time.
        if (!/secondary rate limit/i.test(text) && github.quota?.remaining > 0 && quotaOf(headers)) {
          assert.ok(sleeps < 3, `GitHub keeps refusing although its headers report ${github.quota.remaining} points left; run it again later`);
          continue;
        }
        // The refusal names its own reset; without headers, a minute from now.
        const resetAt = retryAt(text, sleeps, () => quotaOf(headers)?.resetAt ?? new Date(Date.now() + 60_000).toISOString(), Date.now(), headers);
        assert.ok(reserve !== undefined && sleeps < 3, Object.assign(new Error(`The GitHub GraphQL quota is used up until ${untilText(resetAt)}; run the command again after that`), { quotaUsedUp: true }));
        github.sleepUntilReset(resetAt);
      }
    }
  };

  github.rest = path => JSON.parse(run(['api', path], { stdio: 'pipe' }));

  /**
   * One REST write, the only place that builds its `gh` arguments. `fields` are strings (`-f`) or booleans (`-F`), `body` is the text of a
   * `body` field, `json` a whole request body; `header` is one extra header. stdio is piped: without it execFileSync copies gh's raw refusal
   * to stderr, and a caller that reads the last line sees that, not the instruction (#332). Returns gh's answer text.
   */
  github.write = (method, path, { fields = {}, body, json, header } = {}) => {
    const args = ['api', path, '-X', method, ...header ? ['-H', header] : []];
    for (const [key, val] of Object.entries(fields)) args.push(typeof val === 'boolean' ? '-F' : '-f', `${key}=${val}`);
    if (body !== undefined) args.push('-F', 'body=@-');
    if (json !== undefined) args.push('--input', '-');
    return run(args, { input: json !== undefined ? JSON.stringify(json) : body, stdio: 'pipe' });
  };

  // Named operations: the only places that build the `gh` arguments of a pull request merge and of the board setup.
  const text = args => run(args, { stdio: 'pipe' }).trim();
  const json = args => JSON.parse(text(args));
  /** Merges a PR with a merge commit if its head is still `head`; throws gh's refusal. */
  github.mergePr = (repository, number, head) => { run(['pr', 'merge', String(number), '--repo', repository, '--merge', '--match-head-commit', head], { stdio: 'pipe' }); };
  /** Whether gh is signed in. */
  github.signedIn = () => { try { run(['auth', 'status'], { stdio: 'pipe' }); return true; } catch { return false; } };
  github.viewRepository = repository => json(['repo', 'view', repository, '--json', 'viewerPermission,url']);
  github.viewProject = (number, owner) => json(['project', 'view', String(number), '--owner', owner, '--format', 'json']);
  github.copyProject = (number, sourceOwner, targetOwner, title) =>
    json(['project', 'copy', String(number), '--source-owner', sourceOwner, '--target-owner', targetOwner, '--title', title, '--format', 'json']);
  github.projectFields = (number, owner) => json(['project', 'field-list', String(number), '--owner', owner, '--format', 'json', '--limit', '100']);
  github.linkProject = (number, owner, repository) => { text(['project', 'link', String(number), '--owner', owner, '--repo', repository]); };
  github.labelNames = repository => json(['api', `repos/${repository}/labels?per_page=100`, '--paginate', '--slurp']).flat().map(label => label.name);
  github.createLabel = (repository, name, color) => { text(['label', 'create', name, '--repo', repository, '--color', color]); };

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

  /**
   * What GraphQL shows of the PR changes only when REST shows a change too (head, state, draft, merge state, update time, check runs,
   * check suites, commit statuses), so a round that finds the same marker reads GraphQL no more: comments, reviews and reactions are
   * REST reads anyway and the clock is the current one. `head` is the commit the marker names; `pull`, `runs` and `statuses` are what
   * REST answered (pausedRound shows them). Undefined when REST cannot say.
   * ponytail: checks stop at 100 like the GraphQL query; replace when that query paginates.
   */
  github.changeMarker = (repository, prNumber) => {
    try {
      const pull = github.rest(`repos/${repository}/pulls/${prNumber}`), commit = `repos/${repository}/commits/${pull.head.sha}`;
      const listed = (path, key) => github.rest(`${commit}/${path}?per_page=100`)[key];
      const [runs, suites, statuses] = [listed('check-runs', 'check_runs'), listed('check-suites', 'check_suites'), listed('status', 'statuses')];
      return { head: pull.head.sha, pull, runs, statuses, text: JSON.stringify([pull.head.sha, pull.updated_at, pull.state, pull.draft, pull.mergeable_state,
        runs.map(run => [run.id, run.status, run.conclusion]), suites.map(suite => [suite.id, suite.status, suite.conclusion]),
        statuses.map(status => [status.context, status.state, status.description])]) };
    } catch { return undefined; } // a failed marker read is a full read, never a verdict
  };

  // The last full read of a run (the marker REST showed before it, the PR and its unresolved threads), shared by every command of the run.
  // A full read is repeated after this long even without a change, so a GraphQL answer that lagged behind REST heals. Not kept across runs (#694).
  let lastRead;
  const fullReadEvery = 5 * 60_000;
  /** The last full read when `marker` is the one it was made under and it is still fresh, else undefined. */
  github.recallRead = (marker, now = Date.now()) => marker && lastRead?.marker.text === marker.text && now - lastRead.at < fullReadEvery ? lastRead : undefined;
  /** Keeps a full read (`{ marker, pr, threads, at }`); a falsy value forgets the last one. */
  github.keepRead = read => { lastRead = read || undefined; };

  /** Seconds to pause between two reads of a wait: longer with every quiet read and while little quota is left (`paused`: REST is read in place of GraphQL). */
  github.pause = (quietReads, paused) => waitInterval(quietReads, paused ? undefined : github.quota?.remaining);

  // Field and option ids of the Project change rarely: kept in the clone's Git directory (shared by its worktrees) and read again only when
  // a name or option is missing from them or a write with them fails. One read costs a point; every run used to pay it.
  const fieldsFile = () => {
    assert.notEqual(env.BOARD_FIELD_CACHE, '0', 'field cache switched off'); // the board tests change definitions between calls
    // Read from the files, not `git rev-parse`: a worktree's `.git` is a file naming its directory, whose `commondir` names the shared one.
    let dir = join(projectDirectory, '.git');
    if (statSync(dir).isFile()) dir = resolve(projectDirectory, readFileSync(dir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    if (existsSync(join(dir, 'commondir'))) dir = resolve(dir, readFileSync(join(dir, 'commondir'), 'utf8').trim());
    return join(dir, 'board-project-fields.json');
  };
  github.dropFieldsCache = () => { if (env.BOARD_FIELD_CACHE !== '0') rmSync(fieldsFile(), { force: true }); };
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
