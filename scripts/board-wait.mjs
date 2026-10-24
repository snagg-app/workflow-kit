// `wait`, `quota-wait` and the polling they share.
// Its functions run nothing when imported; run-time data comes from board-context.mjs, helpers of other commands by import.
import { QuotaPause, StillWaiting } from './github.mjs';
import { sleepers, untilText } from './quota.mjs';
import { shared } from './board-args.mjs';
import { isResult, result } from './board-result.mjs';
import { args, command, env, github, graphql, number, numberOption, progress, project, rest, stallOption, startedAt } from './board-context.mjs';
import { quotaLine } from './board-common.mjs';
import { isOptional, readPr, reviews, unresolvedThreads, useBaseSettings } from './board-reviews.mjs';

/** What `board.mjs help` and the parser know about the commands; `run` names the function this module returns. */
export const specs = [
  { name: 'wait', run: 'wait', doc: 'docs/board/wait.md', words: [{ name: 'PR', kind: 'number' }],
    summary: 'Waits until CI and every reviewer of the PR head have finished. Exit 0 done, 1 red CI, 3 waiting, 4 call again, 2 error; prints blockers and Sonar issues.',
    flags: { '--merged': { help: 'Wait for the human merge instead (REST only).' }, '--stall': shared.stall, '--grace': shared.grace,
      '--head': { value: 'SHA', kind: 'sha', help: 'The id you just pushed: keep waiting while the PR still shows another head.' }, '--max-minutes': shared.maxMinutes,
      '--interval': { value: 'SECONDS', kind: 'seconds300', help: 'A fixed pause between looks, 0 to 300, raised to 10 (default: 60 growing to 300).' } },
    check: args => args.flag('--merged') && args.flag('--head') ? '--head does not combine with --merged' : undefined },
  { name: 'quota-wait', run: 'quotaWait', doc: 'docs/board/quota-wait.md', flags: { '--max-minutes': shared.maxMinutes },
    summary: 'Waits for the shared GraphQL quota. Returns once it has 300 points again, sleeping until the reset (exit 4 if that is after --max-minutes).' },
  { name: 'reviews', run: 'reviewsOnce', hidden: true, words: [{ name: 'PR', kind: 'number' }], flags: { '--stall': shared.stall, '--grace': shared.grace },
    summary: 'One look at the reviewers of the PR head, without waiting.' },
];

/**
 * The result of a review read (`reviews()`): DONE, FAILED (a red head never reads as a finished review) or, while something is awaited, WAITING.
 * Its `blocker:` lines become the blockers, every other line a note. `prior`: blockers found before the read (they make an unfinished read FAILED); `quota`: add the quota line.
 */
function reviewOutcome(review, { prior = [], quota = false } = {}) {
  const verdict = !review.done ? prior.length ? result('failed', 'FAILED') : result('waiting', 'WAITING')
    : review.failed ? result('failed', 'FAILED', { headline: ['FAILED', ...review.reasons?.length ? [review.reasons.join('; ')] : []].join(': ') }) : result('ok', 'DONE');
  const blocker = 'blocker: ', found = review.lines.filter(line => line.startsWith(blocker));
  return { ...verdict, blockers: [...prior, ...found.map(line => line.slice(blocker.length))],
    notes: [...review.lines.filter(line => !line.startsWith(blocker)), ...quota ? [quotaLine()] : []].filter(Boolean), data: { head: review.pr?.headRefOid, reasons: review.reasons ?? [] } };
}

/** One review snapshot with the same verdict and exit status as the background wait. */
const reviewsOnce = () => reviewOutcome(reviews(stallOption()), { quota: true });

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

/**
 * One round of `wait`. An unchanged marker answers from the last full read, brought up to date by the REST reads and the clock, and only
 * while it still says "waiting": every end (DONE, FAILED, a closed PR) is confirmed by a full read, whose result is what is printed.
 * Review thread resolutions leave no mark in REST, which is why no end is taken from the cache.
 */
function reviewsForHead(prNumber = number) {
  const marker = github.changeMarker(project.repository, prNumber), started = Date.now();
  try {
    const recalled = github.recallRead(marker, started);
    if (recalled) {
      const result = lookAtHead(recalled.pr, () => recalled.threads);
      if (!result.done) return result;
    }
    const pr = readPr(prNumber), result = lookAtHead(pr);
    // A PR that shows another head than REST is still catching up, and a result that ended early has no threads: read both again next round.
    github.keepRead(marker && pr.headRefOid === marker.head && result.threads && { marker, pr, threads: result.threads, at: started });
    return result;
  } catch (error) {
    if (error instanceof QuotaPause) return pausedRound(error.resetAt, marker);
    throw error;
  }
}

/** Looks again and again until `look` is done and returns that read; returns the result "still waiting" (WAITING, exit 4) when the time is up. */
async function poll(look) {
  const maxMinutes = numberOption('--max-minutes', 9);
  // One deadline per run, counted from its start (`done` runs the targeted tests first; `merge` polls twice): everything must fit the one tool call.
  if (maxMinutes > 0 && github.deadline === Infinity) github.deadline = startedAt + maxMinutes * 60_000;
  let shown, quiet = 0;
  // Exit 4: not finished, call the command again (a driver's tool call must end before its 10-minute limit).
  const stillWaiting = resetAt => {
    const quotaReset = resetAt ?? (command === 'wait' && github.quota?.remaining < sleepers.wait ? github.quota.resetAt : undefined);
    return result('again', 'WAITING', { notes: [shown, `still waiting: call ${command} again${quotaReset ? ` after ${quotaReset} (GitHub quota pause)` : ''}`, quotaLine()].filter(Boolean) });
  };
  try {
    for (;;) {
      const result = look(), { done, lines } = result;
      if (done) return result;
      // Interim output names what is still awaited, once per change, so a background run is never silent.
      const waiting = lines.filter(line => line.startsWith('waiting:')).join('\n');
      if (waiting !== shown) {
        progress(['WAITING', shown = waiting, quotaLine()].filter(Boolean).join('\n'));
        quiet = 0;
      }
      if (Date.now() >= github.deadline) return stillWaiting(result.pausedUntil);
      // Little quota lengthens the pause, but not while REST is read in place of GraphQL.
      const pause = ['wait', 'merge'].includes(command) && args.flag('--interval') ? Math.max(numberOption('--interval', 0), /^\d+(\.\d+)?$/.test(env.BOARD_MIN_INTERVAL ?? '') ? Number(env.BOARD_MIN_INTERVAL) : 10) : github.pause(quiet++, result.pausedUntil);
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * pause, github.deadline - Date.now())));
    }
  } catch (error) {
    if (!(error instanceof StillWaiting)) throw error;
    return stillWaiting(error.resetAt);
  }
}

async function wait() {
  const polled = await poll(args.flag('--merged') ? mergeState : reviewsForHead);
  return isResult(polled) ? polled : reviewOutcome(polled, { quota: true });
}

/**
 * Returns once the GraphQL quota has as many points as `wait` needs (300), so a driver never builds its own loop around `gh`: a
 * refused `gh api graphql` prints the error and may still exit 0. The reset comes from the headers of the answer; after --max-minutes
 * the command ends "still waiting" (exit 4) with the reset time, like `wait`.
 */
async function quotaWait() {
  const polled = await poll(() => {
    for (;;) {
      graphql('query{viewer{login}}'); // sleeps first while the last answer showed too few points, and again when a refusal comes
      if (!(github.quota?.remaining < sleepers[command])) return { done: true }; // an answer without headers is an answer
      github.sleepUntilReset(github.quota.resetAt);
    }
  });
  return isResult(polled) ? polled : result('ok', 'DONE', { notes: [quotaLine()].filter(Boolean) });
}

export { reviewOutcome, reviewsOnce, reviewsForHead, poll, wait, quotaWait };
