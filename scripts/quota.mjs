// GitHub's GraphQL quota is 5000 points an hour for the whole account, shared by every agent on it.
// Pure helpers for board.mjs, kept apart so tests can call them without running a command.

// Commands that sleep until the quota reset instead of failing, with the points they keep in reserve.
export const sleepers = { wait: 300, reviews: 50, handoff: 50, done: 50, 'quota-wait': 300 };

/** A failed `gh api graphql` call: GitHub's error type RATE_LIMITED, its message, or a secondary limit. */
export const isRateLimited = text => /RATE_LIMIT|API rate limit|secondary rate limit/i.test(text);

/**
 * What `gh api -i` prints: the status line and the headers, an empty line, then the body. A failed call prints the same
 * to stdout, so a refusal carries its own reset time. Without headers (an older output) everything is the body.
 */
export function splitResponse(text) {
  const output = String(text ?? '');
  const head = /^HTTP\/\S+ \d+[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n/.exec(output);
  const headers = {};
  for (const line of head?.[1].split(/\r?\n/) ?? []) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: head ? output.slice(head[0].length) : output };
}

/**
 * The quota GitHub reports in the headers of every response (`x-ratelimit-remaining`, `x-ratelimit-reset` in epoch seconds),
 * or undefined without them. Unlike `gh api rate_limit` it is the answer of the very request that was just made.
 */
export function quotaOf(headers) {
  const [remaining, reset] = [headers['x-ratelimit-remaining'], headers['x-ratelimit-reset']].map(value => value === undefined || value === '' ? NaN : Number(value));
  return Number.isFinite(remaining) && Number.isFinite(reset) ? { remaining, resetAt: new Date(reset * 1000).toISOString() } : undefined;
}

/** A reset time as clock time and minutes until then, so nobody has to calculate. */
export const untilText = (resetAt, now = Date.now()) => `${resetAt} (in ${Math.max(0, Math.ceil((Date.parse(resetAt) - now) / 60_000))} min)`;

/**
 * When to ask again: a secondary limit is a short throttle (1, 2, 4 minutes after the first, second, third refusal, or the
 * `retry-after` header when it asks for longer), so the hourly reset would wait far too long; otherwise `primaryReset()` names the reset.
 */
export function retryAt(text, refusals, primaryReset, now = Date.now(), headers = {}) {
  if (!/secondary rate limit/i.test(text)) return primaryReset();
  const asked = Number(headers['retry-after']);
  return new Date(now + Math.max(60_000 * 2 ** refusals, Number.isFinite(asked) ? asked * 1000 : 0)).toISOString();
}

/**
 * Seconds between two reads of `wait`: 60, then 1.5 times longer per read without news, up to 5 minutes.
 * Below 1000 points left the pause doubles (at most 10 minutes), so a nearly empty quota is not the polling's doing.
 */
export function waitInterval(quietReads, remaining) {
  const base = Math.min(60 * 1.5 ** quietReads, 300);
  return remaining < 1000 ? Math.min(base * 2, 600) : base;
}
