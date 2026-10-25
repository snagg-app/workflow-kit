// Kit deviation from upstream `code-review` (#608, docs/matt-pocock.md): an adversarial third axis.
// Each pair is [upstream text, replacement]; provider-matt-pocock.mjs refuses to generate when upstream moves one.
const brief = `**Failure-paths sub-agent prompt** should include:

- The diff command and commit list, and the spec when there is one (it defines what "wrong" means).
- The brief: "Be adversarial: find where the changed code does the wrong thing. Read the code around each hunk, callers and callees included, not only the diff. Work through every class that applies:
  - **Boundaries**: for each guard the change adds or relies on (try/catch, transaction, cleanup, diagnosis, fallback), enumerate every exception and early exit before it, inside it, in callbacks it invokes and in handoff steps after it: checked and interrupt exceptions, data-access errors thrown from callbacks, lookups placed before the \`try\`, a write inside the handler that fails itself. Name each path that bypasses the guard.
  - **State machines**: for each stateful UI or workflow piece (polling, refresh, retry, cache, live region), build a state × event table. Events: tick, manual refresh, slow response, failure, abort, unmount, key change. Flag cells that drop cached data, abort in-flight work, never settle or leave the user without exactly one announcement.
  - **Absence**: rows pruned by retention, expired, partially kept, never written or deleted meanwhile. Check every classification that reads them.
  - **Races**: overlapping or out-of-order requests, a second writer, first-write-wins records.
  Report each finding as a concrete scenario, starting state and trigger → wrong result, with file:line, marked confirmed (traced in code) or plausible. Report behaviour only; style and spec coverage belong to the other axes. Under 400 words."

If the spec is missing, skip the Spec sub-agent`;

export const codeReviewFailurePaths = [
  ["two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/spec asked for?). Runs both reviews",
    "three axes: Standards (does the code follow this repo's documented coding standards?), Spec (does the code match what the originating issue/spec asked for?) and Failure paths (which exception, state, absence or race breaks it?). Runs all three reviews"],
  ['Two-axis review', 'Three-axis review'],
  ['originating issue / spec?\n\nBoth axes run',
    'originating issue / spec?\n- **Failure paths**: which exception, state, absence or race path makes the changed code do the wrong thing?\n\nAll three axes run'],
  ['### 4. Spawn both sub-agents in parallel\n\nIssue both sub-agent calls together', '### 4. Spawn the sub-agents in parallel\n\nIssue all three sub-agent calls together'],
  ['If the spec is missing, skip the Spec sub-agent', brief],
  ['Present the two reports under `## Standards` and `## Spec` headings', 'Present the three reports under `## Standards`, `## Spec` and `## Failure paths` headings'],
  ["Don't pick a single winner across axes: that's the reranking the separation exists to prevent.",
    "Don't pick a single winner across axes: that's the reranking the separation exists to prevent.\n\nWhen the review ran against a PR base and its findings are fixed or justified, record it for `board.mjs done` (#1036; it refuses a PR that changes `db/migration` without it): commit the fixes, then run `node .vendor/workflow-kit/scripts/review-marker.mjs` from the worktree root. It writes the reviewed head into the git dir; a later change to a migration file asks for a new review."],
  ['the two axes are deliberately separate (see _Why two axes_)', 'the axes are deliberately separate (see _Why separate axes_)'],
  ['## Why two axes', '## Why separate axes'],
  ['→ **Spec pass, Standards fail.**\n',
    '→ **Spec pass, Standards fail.**\n- Code that is right on the happy path but loses its guarantee when a callback throws, a row was pruned or two requests race → **Standards and Spec pass, Failure paths fail.**\n'],
];

export const adaptCodeReview = content => codeReviewFailurePaths.reduce((text, [from, to]) => {
  if (text.split(from).length !== 2) throw new Error(`code-review: upstream moved ${JSON.stringify(from.slice(0, 60))}; port scripts/code-review-failure-paths.mjs`);
  return text.replace(from, to);
}, content);
