# Agent rules

Read the first two sections once per task with the project's AGENTS.md, then only the
rows your step needs. Follow the harness's instruction hierarchy and the project's
contracts. Links resolve inside this kit.

| When | Read |
| --- | --- |
| Always | Hard rules, Economy, Engineering |
| Start or resume an issue; hand off | [Start or resume](#start-or-resume), [Workflow](#workflow) |
| Git settings or a kit that has a branch checked out | [Session start](#session-start) |
| Kit issue from a project worktree | [Kit issues from a project worktree](#kit-issues-from-a-project-worktree) |
| A hook hint ("hooks are OFF", outdated checkout) | [Hooks](#hooks) |
| Pick work, start authorization, blockers | [Starting work](docs/CONTRIBUTING.md#starting-work) |
| Write or change an issue | [Issues](docs/CONTRIBUTING.md#issues) |
| Branch, PR, review loop | [Delivery](docs/CONTRIBUTING.md#delivery) |
| Predecessor PR still open | [Stacked pull requests](docs/CONTRIBUTING.md#stacked-pull-requests) |
| Blocked, failed or out-of-scope work | [Blockers and scope](docs/CONTRIBUTING.md#blockers-and-scope) |
| Several drivers at once | [Parallel drivers](docs/parallel-drivers.md) |
| Set up or update the kit, hooks | [README](README.md), [SETUP](SETUP.md) |

## Hard rules

- Humans accept and merge. Never merge, enable auto-merge or set Done before a
  human merged. One exception ([#244](https://github.com/snagg-app/workflow-kit/issues/244)):
  the Renovate bot merges its own dependency PRs of this kit once their CI is green. It binds the bot, never an agent.
- Agents leave specs (label `spec`, `"specLabel"` in the project file) untouched: only a human-invoked `spec-review`
  or a human changes their status, in any direction. Agents never invoke the skill or reproduce its review as a status-changing audit.
  Specs stay in Backlog; that skill alone hands one to Human review after a complete review that created or linked no sub-issue.
  Closing it and the status Done stay with a human; `board.mjs` refuses Done and never closes a spec.
- Never force-push, rewrite shared history, reset, stash or discard work you don't
  own, or bypass branch protection, required checks or spending limits. One exception:
  `--force-with-lease` on your own upper layer of a [stacked PR](docs/CONTRIBUTING.md#stacked-pull-requests),
  never on another layer and never plain `--force`.
- Remove only worktrees you created yourself. Remove others (e.g. under `.claude/worktrees/`)
  only on a human's explicit instruction, and use `--force` on them only
  when `git status` is clean and nothing is unpushed.
- Never expose secrets or commit personal configuration.
- A question a human must decide is never skipped, answered by you or worked around.
  Ask it overview first, then through the harness's question tool in batches of at
  most 4 ([Human input](docs/CONTRIBUTING.md#human-input)).

## Economy

- Tokens and Actions minutes are budgets. Read only what the step needs, reuse
  evidence whose inputs are unchanged, and wait for CI and reviews with
  `board.mjs done` or `wait PR` in the background (a driver subagent runs it in the foreground and calls it again on
  exit 4 "still waiting", see [parallel drivers](docs/parallel-drivers.md#driver-regeln) rule 4) instead of hand-written polling loops.
  A foreground `wait`, `merge` or `quota-wait` call sets the shell tool's timeout to 600000 ms, with `--max-minutes` at most 9;
  the tool's default of 2 minutes would push it into the background.
- Search and read the target branch's state (`git grep … origin/<branch>` when the
  checkout differs). Run search and Explore subagents in the foreground
  (`run_in_background: false`) so exactly one report returns.
- Every push restarts CI and reviews: finish fixes and formatting before pushing.
- Cost is turns × context size, since each turn rereads the whole context. Coordinating
  sessions keep their context small and take few turns.
- Message another session or agent only when the recipient must act: no status
  updates or acknowledgements, and bundle several points into one message.
- Read files in excerpts (search, line range) and trim command output. Driver and
  subagent reports stay within about 8 lines.
- If the account owner sets a usage limit, check it before starting each new agent
  and start nothing new once it is reached.
- Use native stacks to continue dependent work at the current stack tip; their depth has no
  local maximum. Real planning and product tasks remain valid issues; wait or summary issues
  for stack depth or merge-queue progress do not.
- No routine setup reruns, broad audits, or new CI jobs and triggers without an
  estimate of the added usage; get approval when the budget is unknown.

## Engineering

- Understand the affected flow, contracts and callers first. Fix the root cause at
  the narrowest shared layer with the smallest complete change.
- Verify each review finding against the code and contract first; fix its
  neighboring paths in the same push. If the same class of finding returns after
  two correction pushes, stop patching and re-examine the whole area's states, data
  flow and assumptions.
- Before the first push of a rule, state transition or background flow, write its
  cases per the [review loop](docs/CONTRIBUTING.md#review-loop), step 1.
- Use the first sufficient option: skip speculative work, reuse repository code,
  standard library/platform, installed dependency, then minimal new code. Check
  pinned-version docs before reimplementing; delete obsolete code and abstractions.
- Preserve validation, authorization, privacy, data integrity, error handling,
  attribution and accessibility.
- Scale proof with risk: focused regression, then cross-component contracts, then
  security, migration and recovery, then authorized live targets. Add one focused
  check for new non-trivial behavior in the existing test setup; it must fail on the
  known faulty behavior and assert its preconditions. Cover a cross-layer change
  with its whole flow (save → load → display). Mocks don't prove live integration.
- Treat every warning or deprecation you meet (install, build, lint, tests, CI,
  runtime, browser console) as a finding. Mark deliberate shortcuts with
  `ponytail: <ceiling>; replace when <trigger>`.
- Every finding ends as a verified fix in scope or a linked follow-up issue
  ([findings](docs/CONTRIBUTING.md#findings-and-follow-ups)). Report skipped checks
  and why; untested is not error-free.

## Start or resume

First installation without the kit or Project binding uses the bounded
[bootstrap procedure](SETUP.md#2-repository), then returns here. Existing-project
API, authentication or dependency failures do not qualify.

Read the issue, comments and [start policy](docs/CONTRIBUTING.md#starting-work) and confirm
authorization, external prerequisites and ownership. Another session's issue, branch or PR needs
explicit handover, even under a shared GitHub login. Then the delivery is two commands with the
work between them:

1. `node .vendor/workflow-kit/scripts/board.mjs start ISSUE --session ID`. Your session id: the
   `agent-<id>` of a Claude Code worktree and Codex's thread id are found without `--session`; a
   subagent uses its own agent id, never the parent's `CLAUDE_CODE_SESSION_ID`. `start` runs the
   [execution check](docs/CONTRIBUTING.md#execution-check) first: BLOCKED or UNKNOWN stop and write
   nothing, except a specifically authorized, documented exception; STACKABLE (only an open
   predecessor PR holds the issue) continues as a [stacked PR](docs/CONTRIBUTING.md#stacked-pull-requests).
   Then it assigns you, sets In progress, posts the claim comment (`Agent: claude|codex, Session: ID`
   and the base), brings the kit to its pin and reads every step back. An empty base field stops `start` before any write. No PR yet:
   `start` switches to a new branch from `origin/<base>` (never push to the base; `done` refuses a checkout on or tracking `main`/`release/**`); the first `done` pushes it and opens the Draft PR that
   closes the issue (its body carries the claim line: keep it when you rewrite the body). A claim of
   another session (comment or open PR) blocks unless it is stale or a handover/`--takeover` rewrites it. Abandoned work (no push, comment or status
   change for `staleHours`, default 6, or a Human-review PR with conflicts) is taken over by
   the same call, which writes your session into the line. `board.mjs next --session ID` lists your
   unfinished issues first, and `start` of another issue says `finish #N first` until they are handed
   off. A repeated call resumes. Work on a ticket does not end at Human review: call `next` in your
   loop and handle its **Rückmeldungen** first (a comment, review or thread after your handoff, a
   push-back to In progress or Automated review, an @mention). Answer in the ticket with a comment
   that has the line `Agent: claude|codex, Session: ID` (last line), or hand off again with `done`.
2. Implement and push. `done` first follows the target branch's
   [base-merge policy](SETUP.md#3-board-and-labels).
   `node .vendor/workflow-kit/scripts/board.mjs done ISSUE FILE` then runs the
   targeted tests, marks the PR ready for the pushed head, ticks the acceptance boxes, sets Automated
   review, waits for CI and every non-optional reviewer ([review loop](docs/CONTRIBUTING.md#review-loop)),
   posts the handoff comment from FILE ([Handoff comment](README.md#handoff-comment)) and checks the
   gate (threads, bot replies, Sonar issues) before it sets Human review. A red result names its
   blocker: fix it, push, run `done` again; exit 4 (`still waiting`) means run `done` again.
   A project whose full proof must run after the automated review and before the handoff first runs
   `done ISSUE` without FILE: it ends with `PREPARED` (exit 0) without handoff comment, ticking or
   Human review. Run the proof, then `done ISSUE FILE` for the same head.

A documented blocker exception keeps the current status and failed verdict: claim by hand (assign,
claim comment with the claim line), skip the guarded transition and edit only its permitted scope. If prerequisites
change, stop affected edits and run `start` again. Subagents implement bounded assignments; only the
driver runs `start` and `done`.

## Workflow

| Status | What you do |
| --- | --- |
| Backlog | Nothing without a human request; propose, don't implement. |
| Ready | `board.mjs start` ([Start or resume](#start-or-resume)). |
| In progress | Implement on the issue-linked branch; the PR stays Draft until `board.mjs done`. |
| Automated review | `done` waits for CI and every non-optional reviewer with a trace on the head ([review loop](docs/CONTRIBUTING.md#review-loop)); fix or link each finding, push, run `done` again; run the retro before handoff (drivers: at most 3 friction lines instead). |
| Human review | `done` handed off. A human accepts and merges; feedback meanwhile shows up in `next` (Rückmeldungen). |
| Done | Merged and accepted. |

Run board commands in the project with authenticated `gh`. `board.mjs help` lists them and `board.mjs help COMMAND` shows one
(usage and flags, about 1 KB): read that, not the README ([table of commands](README.md#board-commands)).

## Session start

`board.mjs start` sets and reads back `submodule.recurse true`, `push.recurseSubmodules no` and
`push.default simple`. Report a disabling worktree override, stop the affected Git operations and
preserve it. New submodules need `git submodule update --init`. Preserve local changes; never force
a submodule update.

`.vendor/workflow-kit` is a link to the one kit checkout of the machine, always on `main` and
pulled at every session start. It has no pin: a new kit commit reaches every branch and worktree
without a merge. Never edit, commit or switch branches in that checkout.

## Kit issues from a project worktree

Work on the kit in a worktree of the kit repository, never in the shared checkout behind
`.vendor/workflow-kit` (the next session start would find it dirty and stop updating). Run each
step as its own command with literal absolute paths (`<kit>` = the shared checkout, `<work>` = a new
folder outside it):

1. `git -C <kit> fetch origin main`
2. `git -C <kit> worktree add <work> -b claude/ISSUE-slug origin/main`
3. `git -C <work> submodule update --init --recursive` (the kit's own submodules; tests that need
   them skip with `<submodule> nicht initialisiert` otherwise)
4. Edit, commit and push in `<work>`; open the PR against `snagg-app/workflow-kit`.

Run every board command for the kit issue with
`node .vendor/workflow-kit/scripts/board.mjs --cwd <work> …`; without `--cwd`, status and fields land
on the project board.

## Hooks

Two levels. Level 0 serves every agent, with or without hooks: `AGENTS.md`, the shared skills,
`board.mjs` and `node .vendor/workflow-kit/scripts/kit.mjs check`. `kit check` is the one place of
the kit checks (kit link and state, stale branch, missing `node_modules`; `scripts/kit-check.mjs`);
`board.mjs start` and `next` call it and print the same hints. An agent without hooks runs
`kit check` at session start and follows the hints. Level 1 is Claude and Codex: the hook below
runs the same check earlier, at session start. Hooks speed it up; nothing depends on them.
The kit adds no adapter for further agents.

The hook module `scripts/kit-hook.mjs` installs the Ponytail and Impeccable hooks, fast-forwards a
clean stale checkout, clones the shared kit when it is missing, links it into the project and pulls
it to the newest `main` by itself; its hints name the command when it cannot ([Hooks](README.md#hooks)). Follow the hint: restart once after "hooks are OFF",
and again after an update so skills load current. Do not install hooks yourself unless a hint
persists after the restart. Never write hook trust or personal agent settings; trust and a fresh
session remain the human's.
