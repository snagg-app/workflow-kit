# board.mjs done

`done ISSUE [PR] [HANDOFF_FILE] [--refs] [--no-pr] [--max-minutes N] [--skip-local-tests REASON]`: everything from the last push to Human review. PR defaults to the one open PR
that closes the issue; without one, own commits on top of the claimed base get their branch and Draft PR first (no commit: the FILE-only path of an exploration needs `--no-pr`, else `done` refuses and leaves the status; `done` also refuses on main or release/** and on a branch tracking one, #646); name it for a partial PR (`Refs #N`, no closing link) or with `--refs` (the PR only names the issue, whether or not another PR closes it: only the PR gate runs, and the issue status, assignment and acceptance boxes stay untouched). In order, each step only if still open, so a repeated call after a push or a wait is the same call:
0. The PR base is fetched; an untested head (once per push, not on a repeated call that only waits) that does not contain it gets it merged and pushed, so the tests see what will be merged. A project with [`"doneBaseMerge": "overlap"`](../../SETUP.md#3-board-and-labels) merges only for shared changed paths or a Git-detected conflict; unrelated base changes leave the head intact. A conflict ends in `FAILED` naming the files, the merge aborted: resolve it, push, call `done` again.
   A PR that changes a file matching `"reviewRequiredPaths"` of the target branch's profile (a list of path patterns, `*` within a name, `**` across directories; default `["**/db/migration/**"]`, `[]` for none; [SETUP.md](../../SETUP.md#3-board-and-labels)) also needs a `code-review` of the head (#1036, #1042): `done` reads only the file names and the marker `board-code-review` in the git dir, which `node scripts/review-marker.mjs` (run by the skill `code-review` after its fixes) writes. Without a marker, or after a later change to such a file, `done` fails before the tests and names this step.
   In the kit repository itself (it has `scripts/board-readme.mjs`), `done` also checks, before the push and without tests or network (#1046), that the README command table equals what `node scripts/board-readme.mjs` writes and that every script the PR adds under `scripts/` has a row in `scripts/affected-tests.mjs`. Otherwise it fails and names the command or the file. Projects that use the kit are not checked.
   Without HANDOFF_FILE and without a handoff comment for the (merged) head, `done` only prepares: steps 1 to 5 run (tests, ready, status Automated review, the wait), then it ends with `PREPARED` (exit 0), without ticking the boxes, handoff comment or Human review. Run the final proof then, and `done ISSUE FILE` takes over the same head (its tests are not repeated; a head pushed since is tested again).
1. The targeted tests of the changed files (`affected-tests.mjs --run`, once per head, in the foreground). Each step prints a `run:` line and its duration. The green steps of a head are kept: after a red step the next `done` skips them and a red test file says whether it is in your diff; a push starts all steps anew.
   With `--skip-local-tests REASON`, the driver explicitly skips only this local run and names why. The reason must be non-empty and cannot start with `--`.
   The output names the skipped head and reason; no tested-head marker is written or changed. Name any historical proof with its original SHA in the handoff.
   Base merges, CI, reviews and handoff gates still run. A skipped preparation reports the skip; repeat the flag on later `done` calls to keep skipping.
2. The Draft PR ready for exactly the pushed head (the local `HEAD` is compared with the PR head as a prefix; the PR is reread 6 times, 5 s apart,
   because GitHub can show the previous push for a moment; closed PRs, forks and a head that stays different are refused; written once, only a read-back showing that head ready counts).
   This comes before any wait: bots and Sonar analyze no Draft, so never close and reopen a PR to start them.
3. The acceptance boxes of the issue body ticked (`- [ ]` to `- [x]`; a line that names an issue `#N` or `OWNER/REPO#N` stays open, and code blocks are not touched).
4. Status Automated review, after verifying the declared PR's reference and comment backlink on every delivered issue
   (see [PR backlinks](../CONTRIBUTING.md#pr-backlinks)). A missing backlink on an issue of this repository is set: the native link
   (the GraphQL `addCloseIssueReferences` behind a closing keyword, which acts only on the default branch; read back up to five times, one second
   apart, because GitHub shows it with a delay) and the PR's URL as a comment (a missing comment after the write exits 2). A partial PR gets only
   the backlink comment. It never closes the issue: that happens when the PR merges into the default branch.
5. The wait for CI and every reviewer, as in `wait` below (`--max-minutes`, default 9: `still waiting: call done again`, exit 4). A red check ends `FAILED` (exit 1).
6. The [handoff comment](../../README.md#handoff-comment) from FILE, unless one for this head exists.
7. The gate, then Human review (exit 0 verified, 1 blocked, 2 unreadable or changed state, 3 waiting): the issue is assigned and startable, its PR connection is native
   (read on every page, including manual links on release branches; text and branch links alone do not count), the PR is open and not a draft, checks and
   reviews are finished, threads and conflicts resolved, and the handoff comment for the current head exists. A partial PR (`--refs`, or beside exactly one
   other open PR that closes the issue) needs no native link and has no issue side (`merge PR` is its gate); two open
   closing PRs stay unknown. Conflicts in any layer of a stack block, a lower layer too (it locks the whole stack, #412): the blocker names the order
   (merge the base into the lowest layer, then each layer into the next one up) and `stack-sync TOP`. When the project file lists `"selfReview"` (for example
   `["ponytail-review", "code-review"]`), the PR body must also carry a self-review section (`## Self-review`; `## Selbstprüfung` with `"language": "de"`) that names each of those checks (`merge` asks for
   it too); a heading of any level counts, quoted templates do not, and whether a check was good is not judged. One run lists every missing point
   together (assignment, handoff comment, self-review section, native link, blockers and threads; a refused issue state, an unreadable read or
   running reviews are reported alone or first), so one fix round suffices. An undetermined merge state (`UNKNOWN`) is read again up to 3 times, 3 s apart,
   before it is reported as waiting. A head that is `UNKNOWN` 10 minutes after its push and has no check and no `pull_request` or `workflow_dispatch`
   run is a blocker (`wait`, `done`, `merge`): in a native stack it names the likely cause (a conflict in a lower layer) and `stack-sync`, otherwise
   "push an empty commit". Nothing is dispatched automatically. Session ownership, final proof and whether a finding is justified remain driver responsibilities.
