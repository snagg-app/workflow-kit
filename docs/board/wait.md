# board.mjs wait

`wait PR`: one look at the head repeated (exit 0 done, 1 red CI, 3 waiting, 2 error); `done` and `merge` use the same look. It prints the merge
state and `blocker:` lines (standing change requests, conflicts), because mergeable is not merge-ready. When the PR has a finished
SonarCloud check it counts the head's OPEN and CONFIRMED Sonar issues (the quality gate judges new-code conditions only) and prints a
`blocker:` line for any, after up to 10 `sonar: RULE file:line message` lines (the rest only counted). The read uses `SONAR_TOKEN` from the
environment (the anonymous API reports 0 for private projects); on a refused read the command ends `ERROR` (exit 2), never green.
Without the token it runs `sonar list issues` of the logged-in `sonar` CLI for the same PR; the check run's "0 New issues" counts for
nothing (it judges new code only and hid open issues three times, #1055). Without token and CLI login the command ends `ERROR` (exit 2)
with one line that names `SONAR_TOKEN` and `sonar auth login`. Security hotspots stay a manual read. A Sonar comment
"analysis has failed" posted after the green check shows as a `sonar:` line, not a blocker: it names no revision and is usually about
an older commit, so the head's green check decides. A workflow
whose `pull_request` jobs for the head were all skipped before the Ready event (Draft
guard), with no executed run since Ready, waits (exit 3): the skip proves nothing
about the Ready head. Push a commit to start one: a workflow without a `ready_for_review` trigger never does otherwise.
The kit's own CI skips Drafts this way (`pull_request` types incl. `ready_for_review` and `converted_to_draft`, job `if: github.event_name != 'pull_request' || !github.event.pull_request.draft`);
projects decide on the same guard themselves, the kit ships no CI template.
It prints `correction pushes after ready: N`, the distinct heads pushed (from the branch's push log)
after the PR's first Ready event (a PR opened non-draft counts from its creation; the head that set Ready does not count,
a force-push is one push, a PR that never was ready prints no line). From `N >= 2` it adds
`cap reached: collect non-blocking findings in one follow-up issue` ([review loop](../CONTRIBUTING.md#review-loop)).
It also reports a moved base: `base moved: N commits since merge-base (BASE)` when the PR's base branch has commits the head lacks
(GitHub compare `behind_by`), then `changed on both sides:` with the files the PR and those commits both change (first 10),
or `no file is changed on both sides`. Both lines are information only: no exit code changes, an unreadable push log or comparison prints a note,
and nothing is merged or rebased for you.
`wait` repeats the look (first after 60 s, then at longer intervals up to 5 minutes, again from 60 s
when what it awaits changes; twice as long below 1000 quota points; `--interval SECONDS` sets a fixed pause instead, at least 10 s), prints `WAITING` lines on change and
reads GraphQL only when REST shows a change since the last full read (head, update time, merge state, check runs, check suites,
commit statuses), at least every 5 minutes, and confirms every end with a full read; the other rounds cost no GraphQL points.
`wait PR --merged` reads REST only. It ends with `DONE`, `FAILED` (as soon as a check fails or a non-draft PR has merge conflicts, `blocker: merge conflicts`) or `ERROR`. Both end
with a `quota: …` line (points left, points this run used, reset time). When GitHub's shared GraphQL
quota is used up or low (under 300 points for `wait`, 50 for `done`), `done` sleeps until the reset and
says so on stderr (`rate limited until 2026-10-07T04:20:34.000Z (in 7 min)`). `wait` does not sleep: it keeps reading the PR and its checks
over REST (the `waiting:` line counts pending, failed or cancelled and passed checks, older runs included, and gives no verdict),
and reads the threads and the verdict after the reset; at `--max-minutes` it ends `still waiting` with the reset time. Every other command stops with the reset time, also as
minutes from now. Points left and the reset come from the `x-ratelimit-remaining` and `x-ratelimit-reset` headers of the
command's own GraphQL answers, a refusal included, never from `gh api rate_limit`
([parallel drivers](../parallel-drivers.md)). `wait` and `done` take
`--stall MINUTES` (default 20) and `--grace MINUTES` (default 3, or `"reviewerGraceMinutes"` of the project file; `0` turns it off): for that long after
the PR became ready (Ready event, or creation as non-draft) and after each push of the
head (read from the branch's push log, so a reused commit counts too), whichever is later, they keep
waiting for reviewers that start on Ready or on new commits, such as Codex, even when CI is already
green, unless a required bot has already answered for good on this head (a review, a finished comment, a final reaction, or a limit notice such as "usage limit" or "rate limited" in a comment or check): that ends the grace at once, an optional reviewer never does. `wait PR --head SHA` (the id you just pushed, 7 to 40 characters, `git rev-parse HEAD`)
keeps waiting (`waiting: PR still shows head …`) while an open PR still reports another head:
right after a push GitHub serves the previous head for a moment, and a plain `wait` would end `DONE` for it.
A head that never matches waits on until stopped by hand. `wait PR --merged` waits for the human merge
and ends `FAILED: <reasons>` (e.g. `FAILED: check Frontend FAILURE; merge conflicts`) if a check is red or the PR is closed unmerged. After `--max-minutes N` (default 9, `0` = no limit) `wait` stops
unfinished with exit 4 and the line `still waiting: call wait again`, so it ends before the 10-minute limit of an agent's
shell tool; a quota pause that would end after that time is not slept through, the line then names the reset
(`still waiting: call wait again after <time> (GitHub quota pause)`). Call `wait` again on exit 4. Analyzers that create their
check only when finished are awaited when listed in `"awaitApps"`
([setup](../../SETUP.md#3-board-and-labels)). A listed app with no suite on the head fails after the stall time
(`check suite NAME missing …`), a cancelled check of it fails at once; neither counts as clean.
Recognized review traces: checks and statuses, Codex's `Running` summary (its code
and security rows end separately: a security result comment never ends a running code
review), bot 👀 reactions and review requests. Free-text announcements of other bots are not
detected; check such reviewers by hand. Reviewers in `"optionalReviewers"`
([setup](../../SETUP.md#3-board-and-labels)) are skipped for all of these: their checks, comments and
reviews are listed and their 👀 reaction is shown as a note, but they never stall or fail, and nothing is awaited that has not started. One exception: a
check or status of such a reviewer that is already pending (and is no rate limit) is awaited until 10 minutes after the push, so `done` hands off only
after its verdict; `wait` and `done` never request a review. Their open threads and
change requests still block, and an analyzer such as SonarCloud listed there still reports open issues as a blocker.
