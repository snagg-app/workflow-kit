# Workflow Kit

Contribution workflow, GitHub Project setup and agent skills: Ponytail,
Impeccable, Matt Pocock's complete collection, Vercel's `find-skills` and the kit's own
`spec-review` (`/spec-review <spec>`: spec against code, open work becomes sub-issues).
Licensed under MIT. Pinned upstream submodules and the
[find-skills snapshot](.agents/skills/find-skills/NOTICE.md) retain their licenses,
notices and reviewed adaptations in generated skills.

- Agents start at [AGENT_RULES.md](AGENT_RULES.md), linked from the project's AGENTS.md.
- To set up a repository, give your agent [SETUP.md](SETUP.md).

## Install or update in a project

Needs Git, Node 26 and, for the board commands, an authenticated `gh`. Kit commands
act on the Git checkout they run in; from the project root:

```sh
git submodule add https://github.com/snagg-app/workflow-kit.git .vendor/workflow-kit  # first time only
git submodule update --init --recursive
node .vendor/workflow-kit/scripts/init-project.mjs --existing  # kit hooks, .gitignore and .ignore
node .vendor/workflow-kit/scripts/setup-skills.mjs             # skills for Codex and Claude Code
```

Without `--existing`, `init-project` also creates the starter files (AGENTS.md,
CONTRIBUTING.md, issue and PR templates) that are missing; afterwards they belong to
the project and are never overwritten. A template that a kit update adds later does not
reach an existing project: copy it by hand. For the spec form that is
`.vendor/workflow-kit/templates/.github/ISSUE_TEMPLATE/spec.yml` to `.github/ISSUE_TEMPLATE/`,
plus the label `spec` (`gh label create spec`), which the form sets.

`init-project` (also with `--existing`) adds the missing lines of `templates/.ignore` to
the project's `.ignore`, so ripgrep-based search skips the generated provider skill copies
(only `.agents/skills` stays searchable) and `.vendor/`; to search an excluded copy, name its
path (`rg pattern .claude/skills`), then `.ignore` doesn't apply. A project-owned skill in a
provider directory stays visible with `!/.claude/skills/my-skill/` in `.ignore`. Git doesn't read the file; commit it with the other `init-project` outputs: a clean-diff check after
the generators (`git diff --exit-code`) fails on an uncommitted `.ignore`.

To update, move the gitlink first. `git submodule update` checks out the commit the
index records, so run after a bump it silently puts the old kit back, and the
generators then run against it without an error or a diff:

```sh
git -C .vendor/workflow-kit fetch origin
git -C .vendor/workflow-kit checkout <kit-commit>      # the commit to adopt
git add .vendor/workflow-kit
git -C .vendor/workflow-kit submodule update --init    # the kit's own submodules only
git submodule status .vendor/workflow-kit              # must show <kit-commit> without a leading + or -
```

Then run the two generators above. A generator run that changes nothing after an
update proves nothing about the new kit; check the status line first.

The kit supports only Codex and Claude Code. Projects from earlier kit versions keep
their copies for Antigravity, Cursor, OpenCode, Pi and Copilot: `init-project` removes
only the kit's handlers from `.cursor/hooks.json` and `.github/hooks/*.json`, and the
kit never deletes other project files. Delete `.agent/`, `.cursor/`, `.opencode/`,
`.pi/`, `.github/skills/`, `.github/agents/` and `.github/hooks/` by hand (keep files
of your own), or leave them unused.

### Generated files and ownership

The kit owns hook handlers pointing into `~/.ponytail/workflow-kit/` or
`~/.impeccable/workflow-kit/` and the kit init handler (`git ls-files -s -- .vendor/workflow-kit` followed by
`git submodule update --init --checkout`; keep personal hooks elsewhere), and upstream skills, agents and
commands by name. Generated discovery files are ordinary committed files in
`.agents` and `.claude`, plus `.codex/agents`. Equal files stay untouched; changed
content and old links move to `.workflow-kit/replaced/`. Foreign hooks and settings stay.

A fresh clone/worktree discovers these files without generation, links or dependency
installation. Generate only during kit installation/update. An update PR bumps the
gitlink, reruns both generators above and commits their intended outputs. Changed
hook snapshots also need the [installers](#hooks).

### Commit generated files

Commit `.gitmodules`, the kit gitlink, hook definitions, `.agents/hooks` sources,
`.ignore` and all generated discovery files. Personal state, download caches and replaced
files stay ignored. After staging the intended files, preserve Unix launcher modes
in Git explicitly, including on Windows and with `core.filemode=false`:

```sh
git add --chmod=+x -- ":(glob)**/skills/impeccable/scripts/impeccable" ":(glob)**/skills/git-guardrails-claude-code/scripts/block-dangerous-git.sh"
```

The clone test verifies all four executable Git entries. In Linux CI, regenerate,
then run
`git add --intent-to-add --all && git diff --exit-code HEAD`: any diff, including a new
file, means committed outputs were stale.

## Hooks

Every hook of Claude and Codex is a one-line call of `scripts/kit-hook.mjs <Event> --agent <claude|codex>`
(hook JSON on stdin, answer on stdout). The module holds all hook logic and reads the Ponytail, Impeccable and
minimum Node version from `scripts/versions.json`, the only place they are written (the CI Node stays in `.node-version`). The hooks call personal snapshots.
They install and update themselves: at SessionStart the module returns at once and starts both installers in a
detached process (one run per machine, lock in `~/.ponytail/workflow-kit/.install.lock`, log in
`.install.log` next to it). A missing version, a changed version after a kit update or a removed
pinned Node is repaired at the next session start and active from the one after. Needs `node` on PATH;
without it the one-line entry prints a clear message and ends with success. By hand, from the project:

```sh
node .vendor/workflow-kit/scripts/install-ponytail-hooks.mjs    # Ponytail mode at session start
node .vendor/workflow-kit/scripts/install-impeccable-hooks.mjs  # Impeccable UI checks
```

Agents do not run them ([agent rules](AGENT_RULES.md#hooks)); trust stays personal. Review and trust
project hooks in each agent, then start a new session:
`/hooks` in Codex CLI or Claude Code, the hooks view in the Codex app settings.
Missing snapshots produce a SessionStart install hint. Session and subagent starts also run
`git submodule update --init .vendor/workflow-kit` when the kit checkout is missing (fresh
worktree) or not at the commit the gitlink pins (a base merge moves the pin, not the checkout); a kit at its pin stays untouched,
a kit with local changes, unpublished commits or a checked-out branch is not moved (the fast-forward then runs with `submodule.recurse=false`), and both that case and a failure print a hint. The one-line entry itself only does this for a kit that is not there at all (the module lives in the kit). Before that, the module
fast-forwards (`git merge --ff-only`) a checkout that is behind its upstream or `origin/HEAD`, has no commits of its own and a clean working tree (a worktree or driver started
from a stale branch), so the kit follows the new pin in the same step. It compares with the last fetched state, so it needs no network, never fetches and never delays the session.
It also reports such a checkout when local changes stopped the fast-forward. At SessionStart it prints one line when the worktree has a `package.json` with dependencies but no `node_modules` (Node would then resolve modules from a parent checkout); it names the `"setup"` command of `.github/workflow-project.json` (for example `"node scripts/bootstrap.mjs"`) or, without that field, the project's `AGENTS.md`, and never installs. A SubagentStart in
a worktree whose kit you deliberately moved ahead of the gitlink resets it, so stage the new pin (`git add .vendor/workflow-kit`) before starting subagents. Claude Code reads hooks once per session: SessionStart stores a fingerprint of `.claude/settings.json` per `session_id` in `~/.claude/hooks-fingerprint/`, and SubagentStart adds the line "Hooks seit Session-Start geändert: Session neu starten" when the last fetched base (upstream or `origin/HEAD`, no network) has other settings. The warning works only in sessions that start after this handler is merged. Files and manual runs don't prove agent loading or
trust; new definitions need personal review and trust. The Edit, Stop and prompt hooks of Ponytail and Impeccable also start through the module, with the `node` on PATH. See
[Ponytail](docs/ponytail.md) and [Impeccable](docs/impeccable.md) for hook behavior.

### Git hooks

A project's Git hooks in `.githooks/` run only after each clone sets `core.hooksPath`; Git never
does this on checkout. Run per clone, for example from the project's setup script, on a
branch you trust (the default branch), and again after every change to a hook:

```sh
node .vendor/workflow-kit/scripts/install-git-hooks.mjs          # --check only reports
```

It copies `.githooks/` of the current checkout, plus the kit's `post-checkout`, into
`workflow-kit-hooks/` in the clone's Git directory and sets `core.hooksPath` to that absolute
path, shared by all worktrees of the clone. Git then runs the copy, never the working
tree: a branch that changes or adds a file in `.githooks/` does not get that code run on
checkout or push. Only an explicit rerun replaces the copy (and drops hooks that no longer
exist); hooks no longer follow the branch you are on, so a hook change reaches a clone
only through that rerun, for example by rerunning the project's bootstrap. Symlinks in
`.githooks/` are not copied. A `post-checkout` of the project's own is used instead of the
kit's and reported; integrate `scripts/git-hooks/post-checkout` there by hand.

The earlier settings, the relative `.githooks` and absolute paths into this
repository's worktrees with matching `config.worktree` overrides, become the new path.
Git resolves relative paths per worktree, so any other relative value counts as foreign.
It changes a config file only when every `core.hooksPath` entry there (including
`include` files) points to this repository's hooks and is written in that file itself.
Because Git evaluates `includeIf` per worktree and branch, it changes nothing when any
`includeIf` target, whatever its condition, sets a foreign path. Anything else, such as a
foreign path in local, global or system config, stays and is reported: integrate
`.githooks` there yourself. Without `.githooks/` it does nothing.

After a branch checkout (third argument `1`) the kit's `post-checkout` runs
`git submodule update --init --checkout .vendor/workflow-kit`, so the kit follows the gitlink of the
new branch instead of showing `M .vendor/workflow-kit`. It touches only the kit, not other submodules
or `submodule.recurse`, disables Git's own prompts like the SessionStart hook (ssh may still ask on the terminal) and runs none of the kit clone's own hooks. Like any checkout it applies the user's Git configuration, including filters.
A kit with local changes, ignored or untracked files, or commits no remote has
(a clean, published kit behind or ahead of the old pin still follows) is not touched: the hook prints a hint
and the checkout continues; any failure only prints the command. Without a kit gitlink, as in this repository,
it does nothing. Known limit: where the kit has `core.filemode=false`, a purely local mode change is invisible to
Git and the update may reset it.
Migrating from the earlier design (a committed `.githooks/post-checkout`): delete that file, then rerun
the installer, so the kit's current one is copied.

## Board commands

`scripts/board.mjs` reads `.github/workflow-project.json` and uses `gh`. It acts on the project of the
working directory; `--cwd PROJECT_DIR` as the first argument (`board.mjs --cwd PROJECT_DIR next`) reads
the project from that directory instead. Other relative paths (`--body-file`) stay relative to the working directory.
`init-project.mjs`, `setup-skills.mjs` and `affected-tests.mjs` take the same first argument (`takeCwd` in `checkout-root.mjs`),
and then work in that directory, their relative paths (changed files given to `affected-tests.mjs`) included:

- `--help` or `-h` (any command) prints the usage and exits 0 without calling GitHub. A writing command (`start`, `done`, `field`, `new`,
  `block`, `sub`, `body`, `body-replace`, `merge`, `sweep`) refuses any flag (`--flag` or `-f`) and any extra word it does not
  take with the usage line (exit 2) before it reads or writes anything. `field` takes further words of its own.
- `start ISSUE [--session ID]`: everything from Ready to the claim (assignment, In progress, claim comment), each write read back; a repeated call resumes (a step already
  done is skipped). The session is `--session`, else the `agent-<id>` of a Claude Code worktree, else `CODEX_THREAD_ID`, else
  `CLAUDE_CODE_SESSION_ID`. It starts with the execution check of the issue, printed (exit 0 STARTABLE, 1 BLOCKED, 2 UNKNOWN, 4 STACKABLE:
  only an open predecessor PR holds the issue, see [Stacked pull requests](docs/CONTRIBUTING.md#stacked-pull-requests)); BLOCKED and
  UNKNOWN write nothing. The check shows the open PRs with the session their claim names and one line per native sub-issue; with
  `"baseBranch": {"field": "Zielrelease", "pattern": "release/{value}"}` it also prints `base: release/0.1.1 (Zielrelease)` from that
  Project field (an optional `"values": {"main": "main"}` names a fixed branch for such field values instead of the pattern) and a `note:`
  when the value is no branch name, `origin/<base>` is unknown locally or git cannot answer, or `HEAD` does not descend from
  `origin/<base>` (that last one only for an issue with no branch yet and no stack); no fetch, never a verdict. Then `start`:
  sets `submodule.recurse true` and `push.recurseSubmodules no` in the clone (only with a `.gitmodules`) and `push.default simple`, assigns the authenticated user,
  sets In progress and posts the claim comment (`Agent: claude|codex, Session: ID` and `Basis: BRANCH`, the base: the base PR's branch of a stack,
  else the Project base field, else the default branch). It creates no branch and no PR: the first `done` pushes your branch
  (`<agent>/<number>-<title>`, or the checkout's own branch of that shape) and opens the Draft PR (`Closes #N` and the claim line) with its native link.
  An issue that already has an open PR (a takeover, a resume) continues on that PR's branch (`git switch`). Then it runs `git fetch origin`, brings the kit to its pin, and
  last the optional `"setup"` shell command of `.github/workflow-project.json` (for example `"node scripts/bootstrap.mjs"`, run like a `push` command, in the checkout, with `BRANCH`);
  if it fails, `start` ends with an error and the output, claim and status stay, and `start` again resumes. The claim holds the issue for every session whose ID it does not name; once the PR exists, its body line is the claim. Keep the claim
  line when you rewrite the PR body. It ends with
  `START #N session … base … (claim only …)`, or `… branch … base … PR #…` with an existing PR; for a stack it names the PR to link above. Abandoned work (below, `next`) is taken over
  with the same call: `start` writes the new session into the claim line of its PR, or posts a new claim comment. A handover is the same edit of the claim line by hand. A new start is BLOCKED with `finish #N first` while you have an own unfinished issue (a resume or a stack on its work is not).
- `done ISSUE [PR] [HANDOFF_FILE] [--refs] [--no-pr] [--max-minutes N] [--skip-local-tests REASON]`: everything from the last push to Human review. PR defaults to the one open PR
  that closes the issue; without one, own commits on top of the claimed base get their branch and Draft PR first (no commit: the FILE-only path of an exploration needs `--no-pr`, else `done` refuses and leaves the status; `done` also refuses on main or release/** and on a branch tracking one, #646); name it for a partial PR (`Refs #N`, no closing link) or with `--refs` (the PR only names the issue, whether or not another PR closes it: only the PR gate runs, and the issue status, assignment and acceptance boxes stay untouched). In order, each step only if still open, so a repeated call after a push or a wait is the same call:
  0. The PR base is fetched; an untested head (once per push, not on a repeated call that only waits) that does not contain it gets it merged and pushed, so the tests see what will be merged. A project with [`"doneBaseMerge": "overlap"`](SETUP.md#3-board-and-labels) merges only for shared changed paths or a Git-detected conflict; unrelated base changes leave the head intact. A conflict ends in `FAILED` naming the files, the merge aborted: resolve it, push, call `done` again.
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
     (see [PR backlinks](docs/CONTRIBUTING.md#pr-backlinks)). A missing backlink on an issue of this repository is set: the native link
     (the GraphQL `addCloseIssueReferences` behind a closing keyword, which acts only on the default branch; read back up to five times, one second
     apart, because GitHub shows it with a delay) and the PR's URL as a comment (a missing comment after the write exits 2). A partial PR gets only
     the backlink comment. It never closes the issue: that happens when the PR merges into the default branch.
  5. The wait for CI and every reviewer, as in `wait` below (`--max-minutes`, default 9: `still waiting: call done again`, exit 4). A red check ends `FAILED` (exit 1).
  6. The [handoff comment](#handoff-comment) from FILE, unless one for this head exists.
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
- `sweep` (merge loop or chief session, at their usual rhythm): sets every Human-review issue whose open PR has merge conflicts (DIRTY) back to Automated review with a comment, and closes every open issue whose linked PR (same repository) is merged into `release/**` (GitHub closes only for the default branch) with a comment, unless a human reopened it after the merge (then it stays open and is named), one line each, else `clean`; see [parallel-drivers.md](docs/parallel-drivers.md).
  To run it without a person, copy [docs/board-sweep.yml](docs/board-sweep.yml) to `.github/workflows/board-sweep.yml`: it runs `sweep` on every push to
  the PR bases (`main`, `release/**`; adjust) and hourly. It needs the secret `BOARD_TOKEN` (a token that may write the Project and issues; `GITHUB_TOKEN` cannot).
  The reset issues then show up in `next` as stale work (below).
- `next [--session ID]` lists unfinished work before the Ready issues. First **Rückmeldungen**: open issues assigned to you (with a session: whose PR claims it) with a new comment or review on the issue or its PR since your last handoff (`## Übergabe`) or reply (a comment with a line `Agent: claude|codex, Session: ID`), or back in In progress / Automated review after the handoff, and any issue whose comments mention `@login` since then (the last 10 issue comments, 5 PR comments and 5 reviews are read). With a session, `start` of another issue says `finish #N first` while one of your own issues has such feedback. Then, with a session, your own issues (assigned to the login, in In progress or
  Automated review, an open PR whose claim names your session) under "Finish your own work first"; then abandoned work, a "Stale or conflicting" list of issues in
  In progress, Automated review or Human review whose open PR had no activity for `"staleHours"` (project file, default 6; 0 or more) or whose
  Human-review PR has merge conflicts (DIRTY). Activity is the newest update of the issue (comments), its Project item (status) and its open PR
  (push, comments, reviews), including bots. Work without activity for `staleHours` (or on a Human-review issue whose PR has conflicts) has expired: `start ISSUE --session NEW` then
  notes the stale PR instead of BLOCKED (its branch holds nothing either) and writes NEW into its claim line; the assignees stay. `start ISSUE --session NEW --takeover` does the same for a fresh PR (a deliberate phase handover); with a pushed branch but no PR yet it continues on that branch and posts the new session's claim comment.
  Another person than the caller on the issue holds it too, before any PR exists: `check`, `start` and `next` stop with "assigned to LOGIN; pass --takeover to take it over", and `start --takeover` goes on. `start` reads the issue again right before its first write and stops without writing if the check now fails.
  `start` and `done` take `--issue-repo OWNER/NAME` for an issue of another repository than the PR (a kit issue fixed in the project): issue, board, status and comments are that repository's (its `.github/workflow-project.json`), the PR, branch and tests stay in the checkout's. `start` opens the PR with `Closes OWNER/NAME#N`.
  `next` lists STACKABLE issues apart, with the base PR; information only.
- `block ISSUE OWNER/REPO#N`, `sub PARENT CHILD` (native sub-issue, read back; `CHILD` may be
  `OWNER/REPO#N`; an existing link succeeds again; no removing or reordering).
- `new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--status S] [--field NAME=VALUE ...]`:
  create an issue with its required metadata in one call and print one line, `NEW URL | milestone | labels |
  Status | Priority | …`, of the values read back. Title, body file, an open milestone, one label that exists
  (the REST API would create an unknown one), a Priority and every field named in the optional
  `"requiredFields"` of `.github/workflow-project.json` (for example `["Size"]`) are required; `Status`
  and `Priority` are not `--field` values. Everything is validated against the Project and repository before
  the issue exists, so a missing or invalid value creates nothing (`ERROR - reason`, exit 2). The Status is Backlog, or the Project option given by `--status S` (e.g. `Ready`).
  A failure after the issue exists names its URL and the failed step: finish by hand, never create it again.
- `new --from FILE`: create many issues at once. `FILE` is a JSON list (1 to 50 entries) of
  `{ "title", "bodyFile", "milestone", "priority", "labels": [..], "fields": { "Size": "XS" } }`: the values of
  the flags above, `bodyFile` relative to the working directory, Status Backlog. Every entry is checked
  before the first issue exists (an unknown key, label, milestone or option, or a missing required value creates
  nothing and names the entry). The issues are created over REST, which costs no GraphQL points; their Project items
  and fields are then written in blocks of 5 issues (aliased mutations: add, write, read back, 3 requests per block),
  so the GraphQL cost is 1 request for the field definitions plus 3 per block: 4 for up to 5 issues, 10 for 13, 31 for 50
  (instead of 9 per issue). When GitHub refuses a block with "Resource limits for this query exceeded", `new` halves it
  and asks again, down to one issue. An issue that is still refused, or whose values do not read back, is listed with
  the `board.mjs field ISSUE NAME VALUE …` command that finishes it; everything else is complete. The output is one
  `NEW …` line per issue. A failure after the first issue exists names every issue that exists: finish those by hand and
  create only the missing ones. The field definitions are also read once per run by a single `new`, which therefore needs 4 requests (before: 8 to 9).
- `field ISSUE NAME VALUE [NAME VALUE ...] [--spec-review]`: any single-select fields (Status and Priority too), all read back together after writing.
  Every pair is checked against the field definitions before the first write: one invalid pair writes
  nothing and names the valid options. It reports failures as one `ERROR - reason` line (exit 2, nothing else printed), not a stack trace.
  Issue read errors name `OWNER/REPO#N`. `Status "In progress"` needs a startable issue assigned to you, `Status Ready` no decision wait, `Done` is
  refused for a spec. Every spec status write needs `--spec-review`, used only by a human-invoked `spec-review`; Human review reads every sub-issue over REST immediately before writing and refuses open or unreadable children.
  `Status "Automated review" PR [OTHER_ISSUE...]` verifies the backlinks as `done` does. `start` and `done` leave specs untouched and set task status themselves;
  `field` is metadata maintenance.
- `body ISSUE FILE BASE_FILE`: replace an issue body with `FILE` only if the current body
  still equals `BASE_FILE` (the body your change is based on; line endings and trailing
  whitespace are ignored; the text written is `FILE` with LF line endings and no trailing
  whitespace, sent over stdin so the file name never matters), then read it back. A body that
  changed meanwhile is refused with
  a `-`/`+` diff (exit 1, nothing written); a read-back that differs from `FILE` reports
  that another session overwrote it (exit 1, the write is not repeated); API and file
  errors exit 2. See [Changing a body](docs/CONTRIBUTING.md#issues).
- `body-replace ISSUE --from FILE --to FILE`: replace exactly one occurrence of the text in
  `FILE` after `--from` with the text after `--to` (plain text, no regular expressions, one
  replacement per call; line endings and trailing whitespace are ignored like in `body`;
  `--to` may be empty). The body read at that moment is the base, then the write and read-back
  of `body` apply. No match or several matches are refused with the reason (exit 1, nothing
  written; several matches are listed by line); an empty `--from` text, unreadable files and API
  errors exit 2.
- `quota-wait [--max-minutes N]`: returns (`DONE` with the `quota: …` line, exit 0) once GitHub's shared GraphQL quota has
  300 points again, sleeping until the reset taken from the response headers; a pause that would end after `--max-minutes`
  (default 9) is not slept through: it ends `still waiting: call quota-wait again after <time>` (exit 4). Use it, or `wait`, instead of a loop of your own around `gh`:
  a refused `gh api graphql` prints the error and may still exit 0.
- Cost of a call: `BOARD_TRACE=1 node scripts/board.mjs …` prints one `gql COST QUERY` line per GraphQL request to stderr. The Project's
  field and option ids are cached in the clone's Git directory (`board-project-fields.json`, shared by worktrees) and read again only when a
  name or option is missing or a write with them fails; `BOARD_FIELD_CACHE=0` switches the cache off. Delete the file after recreating a field.
- `merge PR [--stack] [--stall MINUTES] [--grace MINUTES] [--interval SECONDS] [--max-minutes N]`: the only way for an agent with merge
  authority to merge ([review loop](docs/CONTRIBUTING.md#review-loop) step 7). It applies the review gates of
  `done` (open non-draft PR, CI green, every reviewer with a trace on the head finished or
  stalled, no `blocker:` line, no open thread, determined merge state, the PR body's self-review section when the project lists `"selfReview"`) and prints the same
  lines. Like `wait` it looks again until CI and every reviewer have finished (`--max-minutes`, default 9: then
  `still waiting: call merge again`, exit 4; `--interval SECONDS`, 0 to 60, sets a fixed pause between looks); a red check or
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
  refusal or a read-back that differs: `ERROR`, exit 2). A layer of a [stack](docs/CONTRIBUTING.md#stacked-pull-requests)
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
  never an error of the merge. Without `--stack` it does not read the issue, claims or the [handoff comment](#handoff-comment).
  After a merge into `main` or a `release/*` branch it runs the project's `push` commands ([Push commands](#push-commands)).
- `stack-sync TOP`: for the native stack of the top PR TOP, merges from the bottom layer up the base into each layer (`git merge`, no
  rebase, no force-push) and pushes it, in a temporary worktree of this checkout. A real conflict stops it with `blocker:`, the layer and the
  files; the merge stays open in the printed worktree. Run it after a lower layer got conflicts or the base moved.
- `wait PR`: one look at the head repeated (exit 0 done, 1 red CI, 3 waiting, 2 error); `done` and `merge` use the same look. It prints the merge
  state and `blocker:` lines (standing change requests, conflicts), because mergeable is not merge-ready. When the PR has a finished
  SonarCloud check it counts the head's OPEN and CONFIRMED Sonar issues (the quality gate judges new-code conditions only) and prints a
  `blocker:` line for any, after up to 10 `sonar: RULE file:line message` lines (the rest only counted). The read uses `SONAR_TOKEN` from the
  environment (the anonymous API reports 0 for private projects); on a refused read the command ends `ERROR` (exit 2), never green.
  Without the token it reads `N New issues` from the SonarCloud check run's summary instead: only a readable 0 passes, a larger count or an
  unreadable summary exits 1 with a `blocker:` line that names `SONAR_TOKEN`. Security hotspots stay a manual read. A Sonar comment
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
  `cap reached: collect non-blocking findings in one follow-up issue` ([review loop](docs/CONTRIBUTING.md#review-loop)).
  It also reports a moved base: `base moved: N commits since merge-base (BASE)` when the PR's base branch has commits the head lacks
  (GitHub compare `behind_by`), then `changed on both sides:` with the files the PR and those commits both change (first 10),
  or `no file is changed on both sides`. Both lines are information only: no exit code changes, an unreadable push log or comparison prints a note,
  and nothing is merged or rebased for you.
  `wait` repeats the look (first after 60 s, then at longer intervals up to 5 minutes, again from 60 s
  when what it awaits changes; twice as long below 1000 quota points; `--interval SECONDS` sets a fixed pause instead), prints `WAITING` lines on change and
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
  ([parallel drivers](docs/parallel-drivers.md)). `wait` and `done` take
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
  ([setup](SETUP.md#3-board-and-labels)).
  Recognized review traces: checks and statuses, Codex's `Running` summary (its code
  and security rows end separately: a security result comment never ends a running code
  review), bot 👀 reactions and review requests. Free-text announcements of other bots are not
  detected; check such reviewers by hand. Reviewers in `"optionalReviewers"`
  ([setup](SETUP.md#3-board-and-labels)) are skipped for all of these: their checks, comments and
  reviews are listed and their 👀 reaction is shown as a note, but they never wait, stall or fail; their open threads and
  change requests still block, and an analyzer such as SonarCloud listed there still reports open issues as a blocker.

### Handoff comment

`done` needs one comment on the PR from the driver (the authenticated GitHub user) that
has the handoff heading on its own line (`## Handoff`, or `## Übergabe` with `"language": "de"` in [the project file](SETUP.md#3-board-and-labels)) and a line `Head: <SHA>` that starts with the
first seven characters of the PR's current head commit. The comment names the head it is
about, so no timestamp is involved: a new head, for example after a review fix, asks for a new
comment, a comment for an earlier push does not count, and it works the same for a head without
a check suite or one that was pushed and checked on another branch first. Put the retro under
the heading `Retro` (any level, usually `###`), one list line per finding, and, after another
heading, the review findings with their disposition and, if a reviewer was unavailable or
stalled, the reviewer, cause and evidence (an optional reviewer only when it found something). Without findings the retro has the single line `Keine Funde`.
Only heading, head and author are checked; the content is for the human reviewer.
With several comments for the head the newest counts. `done ISSUE FILE` posts it unless one for the head exists
and adds the heading and the `Head:` line itself; FILE holds the rest:

```md
<Ergebnis in einem Satz in einfacher Sprache>

### Retro

- <Fund, mit Issue-Link oder Commit, wenn schon behandelt>
- Oder als einzige Zeile: Keine Funde

### Reviews

- Befunde: <je Befund: behoben (Commit), Folge-Issue (Link), oder „keine“>
- Eingeschränkte Reviewer: <Reviewer, Ursache, Beleg, oder „keine“>
```

## Push commands

There is no local CI: a driver runs the targeted tests itself (`done`, above), and the PR checks are the repository's own CI. What
remains is the follow-up of a merge. After `board.mjs merge` merged into `main` or a `release/*` branch it runs, in the foreground and
one after the other (30 minutes each; a failure is a note, the merge stands), the `push` list of `.github/workflow-project.json`
(for example the board sweep, the release-branch sync or the kit pin):

```json
{ "push": ["node .vendor/workflow-kit/scripts/board.mjs sweep"] }
```

- The list is read from the merge commit (GitHub contents API; a project without commands touches no git). The commands run with `BRANCH` in a throwaway worktree of that commit (never in the checkout, which may be old), without setup;
  if that state has the kit gitlink, only `git submodule update --init .vendor/workflow-kit` runs first. Bash is Git for Windows' `bash.exe` on Windows (derived from `git --exec-path`, not the WSL one), `/bin/bash` elsewhere.
- `kitPush` (list, next to `push` in the project's file, read from the project's `main`) runs the same way, with `BRANCH=main`, after `board.mjs merge`
  merged a kit PR into `main` and was started with `--cwd <project>/.vendor/workflow-kit`. A kit clone outside a project knows no project: nothing runs.
- `awaitApps`, `optionalReviewers` and `updateBranchChecks` are read from `.github/workflow-project.json` on the PR's base branch at each look (GitHub contents API),
  not from the checkout; an unreadable file there is an error, never a fallback to the checkout.

## Project test map

`node .vendor/workflow-kit/scripts/affected-tests.mjs` knows only the kit's tests. A project adds its own map in
`.github/affected-tests.json` (`init-project.mjs` does not create it): a path pattern (`*` inside a folder, `**` across
folders, relative to the project root) and a command or a list of commands. The script prints each matching
command once after the kit's tests; `--run` runs them in the project root and stops at the first failure. A green `--run` prints only the test counts (`ok: <command>` per project command), a red one the failure's output; `--verbose` shows every line.
Without the file nothing changes. The changed files are those against the merge base with `origin/main`, or with
`--base origin/release/1.2` for projects that target release branches; files listed as arguments replace them.
`--run` hands that base to the project commands as `AFFECTED_BASE`, for checks that compare against the PR's base.
Run it from the project root: the working directory decides which project it reads.

```json
{
  "backend/domain/**": "sh backend/gradlew -p backend :domain:test",
  "backend/api/**": ["sh backend/gradlew -p backend :api:test", "sh backend/gradlew -p backend :tests:test"],
  "frontend/web/**": "npm --prefix frontend/web run test -- --changed"
}
```

On Windows the commands run through `cmd.exe`, so a bare path or a `./` prefix does not work as the program
(`backend/gradlew` fails there with "'backend' is not recognized"); `sh backend/gradlew` runs on both systems.

The commands run with the permissions of whoever runs the script, like a `package.json` script; change the
file only through a reviewed pull request.

## Developing the kit

```sh
git submodule update --init --recursive    # the tests clone the pinned submodules
node scripts/init-project.mjs --existing
node scripts/setup-skills.mjs
git status --short    # review intended outputs; preserve unrelated work
node --test scripts/tests/<affected>.test.mjs    # add --test-name-pattern for one test
node scripts/affected-tests.mjs    # test files for the changed files (--run runs them); new scripts need a row in its table
```

Locally run only the affected tests; CI runs the commands above plus the full
`node --test scripts/tests` in one Linux job: about 20
runs a month at up to 10 minutes on a free public runner.

Per clone, run `node scripts/install-git-hooks.mjs` once (rerun after changing `.githooks/`). The copied
`pre-push` hook then runs the static file test `scripts/tests/text-files.test.mjs` (stray control characters,
well under a second) and stops the push when it fails. It checks the working tree, adds no network or
fixture tests, and `git push --no-verify` skips it; CI runs everything either way.

### Submodule updates by Renovate

Renovate only moves a submodule pin, so the Ponytail adaptation patch and the committed
skills are stale until regenerated. The workflow `Renovate regenerate` does that on
Renovate pull requests from this repository that change `.vendor/*`. It starts on
`pull_request_target`, so GitHub loads the workflow from `main`: a branch cannot rewrite the
definition that holds the write token. That is safe only because the job never runs code of the
branch (see below), and it must stay so. The job runs
`scripts/update-ponytail.mjs` and `scripts/update-impeccable.mjs` as needed, then the CI
generators, pushes the result to the Renovate branch and approves the repository CI run for the
new head: a push with `GITHUB_TOKEN` makes GitHub create the `pull_request` run but hold it as
`action_required`, and the required check `Workflow Kit checks` stays "expected" until it has run
(a `workflow_dispatch` run beside it is not accepted). The job holds `contents: write`
and `actions: write` (the checkout action fetches with it and drops it; no step that runs a script sees it except the push and approval steps), runs only for
`renovate[bot]` pull requests whose commits are all by bots, and checks out the commit of
Renovate's authenticated event, not the branch name. Whatever the branch changed under
`scripts/` never runs: main's scripts replace it, and only the branch's adaptation patch is
kept as input. Whoever wrote its commits, the branch may not change any workflow, script,
`.node-version` or `renovate.json` against main, apart from the three files the updaters
generate (the Ponytail adaptation patch and `scripts/versions.json` and the Impeccable `SHA256SUMS`). The job
fails instead of running, because the approved CI run executes the branch's workflow definition
(read-only token, no secrets). The job approves only the `pull_request` run of the commit it
pushed (the list is asked for that commit), waits up to two minutes for it and fails when none
appears. Commit author names prove nothing,
so the bot-author rule only leaves branches with other people's commits alone. If the approval
fails, approve the held run on the pull request ("Approve and run") or restart it:
`gh run rerun <id>`. `renovate.json` lists the bot's commit address in
`gitIgnoredAuthors`, so Renovate keeps updating the branch. Submodules are not fetched at
checkout: the job first requires the submodule URLs in the branch's `.gitmodules` to equal
main's and fails otherwise, so a branch cannot point the generators at another repository.
`update-ponytail.mjs` keeps its conflict files in `.workflow-kit/ponytail-resolve/` and
refuses to read, write or delete there when any part of that path is a link.

When upstream edits lines our Ponytail adaptations rewrite, the job fails and names the files.
Run `node scripts/update-ponytail.mjs` on the Renovate branch: it writes the conflicting
files with markers to `.workflow-kit/ponytail-resolve/`. Resolve the markers there, run the
command again to port the patch and regenerate the skills, then commit and push. A branch with
a commit by anyone else is left alone; the same command applies.

Renovate merges its pull requests itself once every check on the head is green, all updates
including skills and hooks ([#244](https://github.com/snagg-app/workflow-kit/issues/244)) and the
commit-pinned actions of the write-capable regenerate workflow ([#401](https://github.com/snagg-app/workflow-kit/issues/401)). The
risk is accepted: vendored skills and hooks steer agents or load executable code, and nobody
reads them before the merge. `platformAutomerge` is on (repository setting "Allow auto-merge"):
GitHub merges as soon as the "Workflow Kit checks" verification required by the "Reviewed main"
ruleset passes, instead of waiting for the next Renovate run, which came too rarely for fast-moving
digests. A Renovate-only commit fails that check until the regenerated outputs are pushed. `rebaseWhen` is
`conflicted`: the ruleset does not require up-to-date branches, and constant rebases after every
`main` merge kept CI pending whenever Renovate checked, so the automerge never fired.
