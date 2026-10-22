// What a board command returns and the one place that prints it.
// A command ends with a result: `{ verdict, exitCode, blockers, notes, details, data }`. Tests and tools compare these values; `render` turns
// a result into text: short by default (verdict, blockers, notes), with `--verbose` also the details, with `--json` as one JSON document.
// Lines that must appear while a command still runs (a long wait, the setup of `start`) go through `output.progress`; no other module prints.

/** How a command ended, and its exit code. The only place that maps one to the other. `waiting`: a snapshot that is not finished; `again`: call the command again. */
export const exitCodes = { ok: 0, failed: 1, error: 2, waiting: 3, again: 4 };

/**
 * `kind` names how the command ended (a key of exitCodes), `verdict` the word an agent reads first (DONE, FAILED, WAITING, MERGED, START, ...).
 * `headline`: the first line when it says more than the verdict (null: no verdict line, as in `next`); `title`: lines above it (`check`).
 * `blockers`: why it did not end well, printed with `bullet`; `inline`: they already stand in the headline (`ERROR - reason`).
 * `notes`: further lines that always print; `details`: lines only `--verbose` prints; `data`: structured values for `--json` and tests.
 */
export function result(kind, verdict, { headline = verdict, title = [], blockers = [], notes = [], details = [], data, bullet = 'blocker: ', inline = false } = {}) {
  return { verdict, kind, exitCode: exitCodes[kind], headline, title, blockers, notes, details, data, bullet, inline };
}

/** `FAILED` with one `blocker:` line per reason (exit 1). */
export const failed = (...blockers) => result('failed', 'FAILED', { blockers: blockers.flat() });

export const isResult = value => typeof value?.verdict === 'string' && value.kind in exitCodes;

/** The lines of a result in the order they print. */
export function linesOf(outcome, { verbose = false } = {}) {
  return [...outcome.title, ...outcome.headline === null ? [] : [outcome.headline], ...outcome.inline ? [] : outcome.blockers.map(blocker => `${outcome.bullet}${blocker}`),
    ...outcome.notes, ...verbose ? outcome.details : []];
}

/** A list cut at `limit` entries ends with "and N more"; `--verbose` shows all. */
export const capped = (list, { verbose = false, limit = 10 } = {}) => verbose || list.length <= limit ? list : [...list.slice(0, limit), `... and ${list.length - limit} more (--verbose shows all)`];

export function render(outcome, { verbose = false, json = false } = {}) {
  if (!json) return linesOf(outcome, { verbose }).join('\n');
  const { verdict, exitCode, blockers, notes, details, data } = outcome;
  return JSON.stringify({ verdict, exitCode, blockers, notes, details, data });
}

/** The printer of one board.mjs call. `--json` keeps stdout to the one document: progress then goes to stderr. */
export function createOutput({ json = false, verbose = false } = {}) {
  const progress = text => (json ? console.error : console.log)(text);
  return {
    progress,
    /** A result that is part of a longer run (a step of `done`) prints when it happens, not as the end. */
    step: outcome => progress(render(outcome, { verbose })),
    finish: outcome => console.log(render(outcome, { verbose, json })),
    text: text => console.log(text),
    diagnostic: text => console.error(text),
  };
}
