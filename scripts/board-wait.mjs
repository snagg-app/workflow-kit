// `wait`, `quota-wait` and the polling they share.
// A factory over `env`, so tests and other commands can import it; other commands are reached through `env.later` when called.
import { QuotaPause, StillWaiting, sleepers } from './github.mjs';
import { untilText, waitInterval } from './quota.mjs';
import { shared } from './board-args.mjs';

/** What `board.mjs help` and the parser know about the commands; `run` names the function this module returns. */
export const specs = [
  { name: 'wait', run: 'wait', doc: 'docs/board/wait.md', words: [{ name: 'PR', kind: 'number' }],
    summary: 'Waits until CI and every reviewer of the PR head have finished. Exit 0 done, 1 red CI, 3 waiting, 4 call again, 2 error; prints blockers and Sonar issues.',
    flags: { '--merged': { help: 'Wait for the human merge instead (REST only).' }, '--stall': shared.stall, '--grace': shared.grace,
      '--head': { value: 'SHA', kind: 'sha', help: 'The id you just pushed: keep waiting while the PR still shows another head.' }, '--max-minutes': shared.maxMinutes,
      '--interval': { value: 'SECONDS', kind: 'seconds300', help: 'A fixed pause between looks, 0 to 300 (default: 60 growing to 300).' } },
    check: args => args.flag('--merged') && args.flag('--head') ? '--head does not combine with --merged' : undefined },
  { name: 'quota-wait', run: 'quotaWait', doc: 'docs/board/quota-wait.md', flags: { '--max-minutes': shared.maxMinutes },
    summary: 'Waits for the shared GraphQL quota. Returns once it has 300 points again, sleeping until the reset (exit 4 if that is after --max-minutes).' },
  { name: 'reviews', run: 'reviewsOnce', hidden: true, words: [{ name: 'PR', kind: 'number' }], flags: { '--stall': shared.stall, '--grace': shared.grace },
    summary: 'One look at the reviewers of the PR head, without waiting.' },
];

/** env: the project, the GitHub adapter, process and argument helpers, the common helpers and `later` (the other commands) */
export function createWait(env) {
  const { args, command, github, graphql, number, numberOption, project, quotaLine, rest, stallOption, startedAt } = env;
  const { isOptional, readPr, reviews, unresolvedThreads, useBaseSettings } = env.later;

  // Waiting is over either way; FAILED keeps a red head from reading as a finished review.
  const outcome = ({ failed, reasons = [] }) => failed ? [['FAILED', ...reasons.length ? [reasons.join('; ')] : []].join(': '), 1] : ['DONE', 0];

  /** Print one review snapshot with the same verdict and exit status as the background wait. */
  function reviewsOnce() {
    const result = reviews(stallOption());
    const [word, code] = result.done ? outcome(result) : ['WAITING', 3];
    console.log([word, ...result.lines, quotaLine()].filter(Boolean).join('\n'));
    process.exitCode = code;
  }

  /** Waiting for the human merge is the other recurring wait; it ends when the PR is no longer open. REST, so it costs no GraphQL points. */
  function mergeState() {
    const pull = rest(`repos/${project.repository}/pulls/${number}`);
    const open = pull.state === 'open';
    // Closed without merge is the end of the wait, but never a delivery.
    return { done: !open, failed: !open && !pull.merged, reasons: ['PR closed without merge'], lines: [`#${pull.number} ${open ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'}`, ...open ? ['waiting: human merge'] : []] };
  }

  /**
   * Right after a push GitHub still reports the previous head, so a plain `wait` can end DONE for it. With `--head SHA`
   * (the id just pushed, 7 to 40 characters, compared as a prefix) an open PR keeps waiting until it shows that head.
   * ponytail: a head that never matches (wrong id, someone else pushed on top) waits on; stop it by hand.
   */
  function lookAtHead(pr, threads) {
    const expected = args.value('--head')?.toLowerCase();
    if (!expected || pr.state !== 'OPEN' || pr.headRefOid.startsWith(expected)) return reviews(stallOption(), Date.now(), pr.number, pr, undefined, threads ?? (current => unresolvedThreads(current.number, current.reviewThreads)));
    return { done: false, lines: [`#${pr.number} ${pr.state} head ${pr.headRefOid.slice(0, 7)}`,
      `waiting: PR still shows head ${pr.headRefOid.slice(0, 7)}, expected ${expected.slice(0, 7)}`] };
  }

  /**
   * What GraphQL shows of the PR changes only when REST shows a change too (head, state, draft, merge state, update time, check runs,
   * check suites, commit statuses), so a round that finds the same marker reads GraphQL no more: comments, reviews and reactions are
   * REST reads anyway and the clock is the current one. `head` is the commit the marker names; `pull`, `runs` and `statuses` are what
   * REST answered (pausedRound shows them). Undefined when REST cannot say.
   * ponytail: checks stop at 100 like the GraphQL query; replace when that query paginates.
   */
  function changeMarker(prNumber) {
    try {
      const pull = rest(`repos/${project.repository}/pulls/${prNumber}`), commit = `repos/${project.repository}/commits/${pull.head.sha}`;
      const listed = (path, key) => rest(`${commit}/${path}?per_page=100`)[key];
      const [runs, suites, statuses] = [listed('check-runs', 'check_runs'), listed('check-suites', 'check_suites'), listed('status', 'statuses')];
      return { head: pull.head.sha, pull, runs, statuses, text: JSON.stringify([pull.head.sha, pull.updated_at, pull.state, pull.draft, pull.mergeable_state,
        runs.map(run => [run.id, run.status, run.conclusion]), suites.map(suite => [suite.id, suite.status, suite.conclusion]),
        statuses.map(status => [status.context, status.state, status.description])]) };
    } catch { return undefined; } // a failed marker read is a full read, never a verdict
  }

  /**
   * The GraphQL quota is used up until `resetAt`: `wait` keeps looking over REST (PR state and checks) instead of sleeping, and the
   * full read (threads, verdict) follows after the reset. It never ends the wait: REST lists every run of the head, so an older run
   * that a newer one cancelled looks failed, and only the full read knows which run decides.
   * ponytail: counts only, no verdict from REST; replace when the decisive run per job can be told apart over REST.
   */
  function pausedRound(resetAt, marker) {
    const lines = [];
    let text = `GitHub quota used up until ${untilText(resetAt)}; threads and the verdict are read after it`;
    if (marker) {
      useBaseSettings({ baseRefName: marker.pull.base.ref }); // no look at the PR has happened yet in this round: the optional list must not come from the checkout
      const checks =[...marker.runs.filter(run => !isOptional(run.app?.slug)).map(run => run.status === 'completed' ? run.conclusion : 'pending'),
        ...marker.statuses.map(status => status.state)];
      const count = names => checks.filter(result => names.includes(result)).length;
      text += `; checks over REST: ${count(['pending'])} pending, ${count(['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])} failed or cancelled, ${count(['success', 'neutral', 'skipped'])} passed`;
      lines.unshift(`#${marker.pull.number} ${marker.pull.state.toUpperCase()} head ${marker.head.slice(0, 7)}`);
    }
    return { done: false, lines: [...lines, `waiting: ${text}`], pausedUntil: resetAt };
  }

  // The last full read of this wait: the marker REST showed before it, the PR and the unresolved threads.
  let lastRead;
  // A full read is repeated after this long even without a change, so a GraphQL answer that lagged behind REST heals.
  const fullReadEvery = 5 * 60_000;

  /**
   * One round of `wait`. An unchanged marker answers from the last full read, brought up to date by the REST reads and the clock, and only
   * while it still says "waiting": every end (DONE, FAILED, a closed PR) is confirmed by a full read, whose result is what is printed.
   * Review thread resolutions leave no mark in REST, which is why no end is taken from the cache.
   */
  function reviewsForHead(prNumber = number) {
    const marker = changeMarker(prNumber), started = Date.now();
    try {
      if (marker && lastRead?.marker?.text === marker.text && started - lastRead.at < fullReadEvery) {
        const result = lookAtHead(lastRead.pr, () => lastRead.threads);
        if (!result.done) return result;
      }
      const pr = readPr(prNumber), result = lookAtHead(pr);
      // A PR that shows another head than REST is still catching up, and a result that ended early has no threads: read both again next round.
      lastRead = marker && pr.headRefOid === marker.head && result.threads && { marker, pr, threads: result.threads, at: started };
      return result;
    } catch (error) {
      if (error instanceof QuotaPause) return pausedRound(error.resetAt, marker);
      throw error;
    }
  }

  /** Looks again and again until `look` is done and returns that result; returns nothing after printing "still waiting" (exit 4). */
  async function poll(look) {
    const maxMinutes = numberOption('--max-minutes', 9);
    // One deadline per run, counted from its start (`done` runs the targeted tests first; `merge` polls twice): everything must fit the one tool call.
    if (maxMinutes > 0 && github.deadline === Infinity) github.deadline = startedAt + maxMinutes * 60_000;
    let shown, quiet = 0;
    // Exit 4: not finished, call the command again (a driver's tool call must end before its 10-minute limit).
    const stillWaiting = resetAt => {
      process.exitCode = 4;
      const quotaReset = resetAt ?? (command === 'wait' && github.quota?.remaining < sleepers.wait ? github.quota.resetAt : undefined);
      console.log(['WAITING', shown, `still waiting: call ${command} again${quotaReset ? ` after ${quotaReset} (GitHub quota pause)` : ''}`, quotaLine()].filter(Boolean).join('\n'));
    };
    try {
      for (;;) {
        const result = look(), { done, lines } = result;
        if (done) return result;
        // Interim output names what is still awaited, once per change, so a background run is never silent.
        const waiting = lines.filter(line => line.startsWith('waiting:')).join('\n');
        if (waiting !== shown) {
          console.log(['WAITING', shown = waiting, quotaLine()].filter(Boolean).join('\n'));
          quiet = 0;
        }
        if (Date.now() >= github.deadline) return stillWaiting(result.pausedUntil);
        // Little quota lengthens the pause, but not while REST is read in place of GraphQL.
        const pause = ['wait', 'merge'].includes(command) && args.flag('--interval') ? numberOption('--interval', 0) : waitInterval(quiet++, result.pausedUntil ? undefined : github.quota?.remaining);
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * pause, github.deadline - Date.now())));
      }
    } catch (error) {
      if (!(error instanceof StillWaiting)) throw error;
      stillWaiting(error.resetAt);
    }
  }

  async function wait() {
    const result = await poll(args.flag('--merged') ? mergeState : reviewsForHead);
    if (!result) return;
    const [word, code] = outcome(result);
    process.exitCode = code;
    console.log([word, ...result.lines, quotaLine()].filter(Boolean).join('\n'));
  }

  /**
   * Returns once the GraphQL quota has as many points as `wait` needs (300), so a driver never builds its own loop around `gh`: a
   * refused `gh api graphql` prints the error and may still exit 0. The reset comes from the headers of the answer; after --max-minutes
   * the command ends "still waiting" (exit 4) with the reset time, like `wait`.
   */
  async function quotaWait() {
    const result = await poll(() => {
      for (;;) {
        graphql('query{viewer{login}}'); // sleeps first while the last answer showed too few points, and again when a refusal comes
        if (!(github.quota?.remaining < sleepers[command])) return { done: true }; // an answer without headers is an answer
        github.sleepUntilReset(github.quota.resetAt);
      }
    });
    if (result) console.log(['DONE', quotaLine()].join('\n'));
  }

  return { outcome, reviewsOnce, reviewsForHead, poll, wait, quotaWait };
}
