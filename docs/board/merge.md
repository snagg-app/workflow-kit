# board.mjs merge

`merge PR [--stack] [--stall MINUTES] [--grace MINUTES] [--interval SECONDS] [--max-minutes N]`: the only way for an agent with merge
authority to merge ([review loop](../CONTRIBUTING.md#review-loop) step 7). It applies the review gates of
`done` (open non-draft PR, CI green, every reviewer with a trace on the head finished or
stalled, no `blocker:` line, no open thread, determined merge state, the PR body's self-review section when the project lists `"selfReview"`) and prints the same
lines. Like `wait` it looks again until CI and every reviewer have finished (`--max-minutes`, default 9: then
`still waiting: call merge again`, exit 4; `--interval SECONDS`, 10 to 60, sets a fixed pause between looks); a red check or
blocker ends `FAILED` (exit 1), an undetermined merge state `WAITING` (exit 3), and nothing is merged. A single PR is merged as it is, also when the base changed the same files (#552).
Only a red check makes it merge the base into the PR branch first (`PUT pulls/N/update-branch` with the checked head as `expected_head_sha`),
wait for the new head and its CI the same way, check the gates again and merge that head: when the only red check is one listed in `"updateBranchChecks"`
(check names, for example `["Restart CI after retarget"]`; `wait` and `done` still end `FAILED`, naming `board.mjs merge N`),
and once for any other red check when the base gained commits since the merge-base (the CI ran on the old merge state, #425); a red check after that update, or on an unmoved base, ends `FAILED`. If GitHub refuses that update with 403 (a PR with stacked children), `merge` ends
`FAILED` (exit 1) and tells you to run `git merge origin/<base>` in the PR's worktree, push once and call `merge` again;
it never pushes for you. A PR that somebody else merged meanwhile ends `MERGED` (note "already merged", exit 0, no second merge) with the steps after a merge (#556);
closed without merge and Draft stay `FAILED`. Otherwise it runs `gh pr merge --merge
--match-head-commit <full head id>` once (a push after the check makes gh refuse; a refusal of a PR with stacked children ("part of a stack", "asynchronous merge REST API" or HTTP 403)
goes once to `PUT pulls/N/merge-async` with `merge_action=direct_merge`, `merge_method=merge` and `sha` = the same head,
and the merge is read back until it shows) and counts
only a read-back showing the PR as merged (`MERGED #N head … merge commit …`, exit 0; any other gh
refusal or a read-back that differs: `ERROR`, exit 2). A layer of a [stack](../CONTRIBUTING.md#stacked-pull-requests)
with an open layer below it is refused (`FAILED`, exit 1): merging it would merge that layer too. `merge TOP --stack` merges
the whole stack in one run instead: TOP is the top layer, and before anything else every open layer must hold its own gate (a
handoff comment for its head, no open thread, no change request, no conflicts (a conflict in a lower layer locks the whole stack), the layer above contains its head, the issues it delivers in Human review, the
self-review section); `FAILED` names the layer and the reason, and nothing is merged. CI and reviewers count for the top head
only (it contains every layer), so the stack costs one CI round. The top alone goes to `merge-async` (never a plain `gh pr merge`, which
would land it in the layer below): GitHub merges every layer below with it, bottom first, and shows each as merged, without retarget.
A trunk that gained commits under files the stack changes ends `FAILED` with the manual way (`git merge origin/<trunk>` in the top layer,
push once, run again), because `update-branch` of the top would only merge the layer below. The output has a `MERGED #N …` line per
layer (`NOT MERGED (STATE) #N …` and exit 2 when GitHub left one open), `issue #N (PR #L): closed` per delivered issue
(merge writes no status). Whatever the stack's trunk is (#418), each issue is read again for about 15 s; one that is still open is closed as completed with a comment naming the merged PR (#397). After the merge it deletes the head branch (every layer's with `--stack`, lower layers first; `branch deleted: …`) unless the repository's setting "Automatically delete head branches" does it,
the branch is not of this repository, is the default branch or is the base of another open PR (a stack: GitHub would close
that PR); it prints `branch kept: …` with the reason. A failed or already done delete is a `note:` or `branch gone:` line,
never an error of the merge. Without `--stack` it does not read the issue, claims or the [handoff comment](../../README.md#handoff-comment).
It then deletes the whole folder of the agent worktree (`.claude/worktrees/NAME`) that has the merged branch checked out, with what Git does not track (`worktree deleted: …`); links in it are unlinked, their targets stay. The folder this run works in is kept, and so is one with uncommitted files or commits beyond the merged head that no remote has (`worktree kept: … holds unsaved work`).
After a merge into `main` or a `release/*` branch it runs the project's `push` commands ([Push commands](../../README.md#push-commands)).
