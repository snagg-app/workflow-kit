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

Needs Git, Node (minimum version in `scripts/versions.json`; `.node-version` is the Node that CI and development use) and, for the board commands, an authenticated `gh`. All projects on a
machine share one kit checkout that always follows `main`; each project reaches it through
the link `.vendor/workflow-kit`. Kit commands act on the Git checkout they run in. Once per
machine, clone the kit next to your projects (`WORKFLOW_KIT_DIR` overrides the place). One
command then sets up or repairs each project, new or existing, and again after every kit update:

```sh
git clone --recurse-submodules https://github.com/snagg-app/workflow-kit.git <projects>/workflow-kit  # once per machine
node <projects>/workflow-kit/scripts/kit.mjs --cwd <project> setup
```

`kit setup` runs the steps below in order, as often as you like; a second run changes nothing. It keeps the
project's own hooks, skills, settings and files. A step that needs the network or your home folder (Ponytail and
Impeccable hooks, the GitHub board without a signed-in `gh`) reports `open` instead of failing the run. It ends with the
steps only a person can do: trusting the hooks and the GitHub switches. The steps are the scripts `init-project`
(a project without `AGENTS.md` also gets the starter files), `setup-skills`, `install-git-hooks`,
`provider ponytail install`, `provider impeccable install` (both only for the functions the project uses, see `"impeccable"` and `"ponytail"` in [SETUP](SETUP.md)) and `setup-github`, plus a `.github/workflow-project.json` stub when missing.

Skills exist once: the files live in `.agents/skills` (Codex reads them there) and are committed. Claude Code reads
`.claude/skills`, which holds one link per shared skill (a junction on Windows, which needs no privilege, else a symlink).
The links are not committed (`init-project` adds `/.claude/skills/*` and `!/.claude/skills/impeccable/` to `.gitignore`):
Git stores no junction, and a Windows checkout without symlink rights turns a committed link into a text file. So every
fresh clone and worktree needs `kit setup` (its `setup-skills` step links; it only links when the files are there) before Claude Code starts; a
SessionStart hook is too late, the session has already read the folder. Impeccable differs per agent and stays a real copy in
each. Skill folders may hold other agents' metadata (`agents/openai.yaml`); it stays in `.agents`, Claude Code sees it
through the link and ignores it.

`init-project` links `.vendor/workflow-kit` to the shared checkout (a junction on Windows,
else a symlink) and adds it to `.gitignore`. It stops at a folder or submodule in that place:
delete it, then rerun. From then on the hooks do the rest, see [Hooks](#hooks).

Without `--existing`, `init-project` also creates the starter files (AGENTS.md,
CONTRIBUTING.md, issue and PR templates) that are missing; afterwards they belong to
the project and are never overwritten. A template that a kit update adds later does not
reach an existing project: copy it by hand. For the spec form that is
`.vendor/workflow-kit/templates/<language>/.github/ISSUE_TEMPLATE/spec.yml` (`en` or `de`, the profile language) to `.github/ISSUE_TEMPLATE/`,
plus the label `spec` (`gh label create spec`), which the form sets.

`init-project` (also with `--existing`) adds the missing lines of `templates/.ignore` to
the project's `.ignore`, so ripgrep-based search skips the Claude Code skill links
(only `.agents/skills` stays searchable) and `.vendor/`; to search an excluded copy, name its
path (`rg pattern .claude/skills`), then `.ignore` doesn't apply. A project-owned skill in a
provider directory stays visible with `!/.claude/skills/my-skill/` in `.ignore`. Git doesn't read the file; commit it with the other `init-project` outputs: a clean-diff check after
the generators (`git diff --exit-code`) fails on an uncommitted `.ignore`.

There is no kit update step in a project: the next session start pulls the shared checkout, so
every branch and worktree has the newest kit without a merge. A plain `kit setup` never changes a
Git-tracked file under `.agents`, `.claude/skills`, `.claude/agents` or `.codex/agents`: the committed copies are the
project's snapshot, so starting an agent leaves `git status` clean (#877). After a kit update, refresh the snapshot on purpose:
run `kit setup --refresh` (or `setup-skills.mjs --refresh`) and commit what it changes; a run without `--refresh`
proves nothing about the new kit.

The kit has hook adapters only for Codex and Claude Code. Any other agent works at level 0
(`AGENTS.md`, skills, `board.mjs`, `kit.mjs check`; see [Hooks](AGENT_RULES.md#hooks)); an
agent without hooks has `hooks: null` in `scripts/agents.mjs`, and `kit setup` then names the one
line for its `AGENTS.md`. The kit no longer touches files of other agents (Antigravity, Cursor,
OpenCode, Pi, Copilot) or its own old ones; delete them by hand (keep files of your own).

### Generated files and ownership

The kit owns every hook handler with the id `workflow-kit` (keep personal hooks elsewhere), and upstream skills, agents and
commands by name. Generated discovery files are ordinary committed files in
`.agents`, `.claude/skills/impeccable` and `.claude/agents`, plus `.codex/agents`; of `.claude/skills/impeccable` only the files that differ from `.agents/skills/impeccable` are committed (setup copies the others; a generated `.gitignore` in that folder names them), and `impeccable_*.toml` is committed only in `.codex/agents`; the other Claude Code skills are local links to `.agents/skills`. Equal files stay untouched; changed
content and old links move to `.workflow-kit/replaced/`. Foreign hooks and settings stay.

A fresh clone/worktree discovers the committed files without generation or dependency
installation; Claude Code additionally needs the skill links from `setup-skills`. Generate only during kit installation/update. An update PR reruns both generators above with `--refresh` and commits their intended outputs. Changed
hook snapshots also need the [installers](#hooks).

### Commit generated files

Commit hook definitions, `.agents/hooks` sources,
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

Every hook of Claude and Codex is a short call of `.agents/workflow-kit-hook.mjs <Event> --agent <claude|codex>`
(hook JSON on stdin, answer on stdout), plus the "Node is missing" notice at SessionStart and SubagentStart. That file is a copy of
`scripts/kit-entry.mjs` that `kit setup` writes: it is the one place that finds the shared kit and clones it when missing
(SessionStart and SubagentStart only), then hands over to `scripts/kit-hook.mjs`. Hook notices follow `language` of the profile. SessionStart and SubagentStart also link `.vendor/workflow-kit` in every other worktree of the project (a subagent with `isolation: worktree` gets no session hook, and its hook call carries the parent's cwd); `board.mjs start` repairs a missing link itself and says so in one line. No `WorktreeCreate` hook: it replaces the host's worktree creation, which is too much for a link. The module holds all hook logic and reads the Ponytail, Impeccable and
minimum Node version from `scripts/versions.json`, the only place they are written (the CI Node stays in `.node-version`). The hooks call personal snapshots.
They install and update themselves: at SessionStart the module returns at once and starts both installers in a
detached process (one run per machine and function through the provider's own lock, log in
`~/.ponytail/workflow-kit/.install.log`). A missing version, a changed version after a kit update or a removed
pinned Node is repaired at the next session start and active from the one after. Needs `node` on PATH;
without it the one-line entry prints a clear message and ends with success. By hand, from the project:
`node .vendor/workflow-kit/scripts/kit.mjs setup` (it runs both installers).

Agents do not run them ([agent rules](AGENT_RULES.md#hooks)); trust stays personal. Review and trust
project hooks in each agent, then start a new session:
`/hooks` in Codex CLI or Claude Code, the hooks view in the Codex app settings.
Missing snapshots produce a SessionStart install hint. The one-line SessionStart and SubagentStart entries only clone the shared checkout (`https://github.com/snagg-app/workflow-kit.git`, no prompts) when it is missing, at `WORKFLOW_KIT_DIR` or else `workflow-kit` next to the project's main checkout (also from a worktree), then start the module, which lives in the kit. The module links `.vendor/workflow-kit` to the shared checkout when the link is missing or points elsewhere. At SessionStart (not on a compaction) it also runs `git pull --ff-only` and `git submodule update --init` in the shared checkout, each with a 40-second limit, no prompts and none of the checkout's Git hooks; a lock directory in the checkout's `.git` makes a parallel session skip the update instead of waiting. A checkout with local changes, unpublished commits, another branch or a fixed revision is never touched: the hook prints a hint (a failed pull prints one too). Work on a fixed revision with `git -C <checkout> checkout <sha>` and return with `git switch main`. Kit work belongs in a worktree of the kit repository, never in the shared checkout. A project that still holds the kit as a submodule is only reported (run `init-project`). The module does nothing in a project without kit hooks and in the kit's own repository. Before that, the module
fast-forwards (`git merge --ff-only`) a project checkout that is behind its upstream or `origin/HEAD`, has no commits of its own and a clean working tree (a worktree or driver started
from a stale branch). It compares with the last fetched state, so that step needs no network, never fetches and never delays the session.
It also reports such a checkout when local changes stopped the fast-forward. At SessionStart it prints one line when the worktree has a `package.json` with dependencies but no `node_modules` (Node would then resolve modules from a parent checkout); it names the `"setup"` command of `.github/workflow-project.json` (for example `"node scripts/bootstrap.mjs"`) or, without that field, the project's `AGENTS.md`, and never installs. Claude Code reads hooks once per session: SessionStart stores a fingerprint of `.claude/settings.json` per `session_id` in `~/.claude/hooks-fingerprint/`, and SubagentStart adds the line "Hooks seit Session-Start geändert: Session neu starten" when the last fetched base (upstream or `origin/HEAD`, no network) has other settings. The warning works only in sessions that start after this handler is merged. Files and manual runs don't prove agent loading or
trust; new definitions need personal review and trust. The Edit, Stop and prompt hooks of Ponytail and Impeccable also start through the module, with the `node` on PATH. See
[Ponytail](docs/ponytail.md) and [Impeccable](docs/impeccable.md) for hook behavior.

### Git hooks

A project's Git hooks in `.githooks/` run only after each clone sets `core.hooksPath`; Git never
does this on checkout. Run per clone, for example from the project's setup script, on a
branch you trust (the default branch), and again after every change to a hook:

```sh
node .vendor/workflow-kit/scripts/install-git-hooks.mjs          # --check only reports
```

It copies `.githooks/` of the current checkout into
`workflow-kit-hooks/` in the clone's Git directory and sets `core.hooksPath` to that absolute
path, shared by all worktrees of the clone. Git then runs the copy, never the working
tree: a branch that changes or adds a file in `.githooks/` does not get that code run on
checkout or push. Only an explicit rerun replaces the copy (and drops hooks that no longer
exist); hooks no longer follow the branch you are on, so a hook change reaches a clone
only through that rerun, for example by rerunning the project's bootstrap. Symlinks in
`.githooks/` are not copied.

Absolute paths into this repository's worktrees with matching `config.worktree` overrides become the new path.
Git resolves relative paths per worktree, so any other relative value counts as foreign.
It changes a config file only when every `core.hooksPath` entry there (including
`include` files) points to this repository's hooks and is written in that file itself.
Because Git evaluates `includeIf` per worktree and branch, it changes nothing when any
`includeIf` target, whatever its condition, sets a foreign path. Anything else, such as a
foreign path in local, global or system config, stays and is reported: integrate
`.githooks` there yourself. Without `.githooks/` it does nothing.

## Board commands

`scripts/board.mjs` reads `.github/workflow-project.json` and uses `gh`. It acts on the project of the
working directory; `--cwd PROJECT_DIR` as the first argument (`board.mjs --cwd PROJECT_DIR next`) reads
the project from that directory instead. Other relative paths (`--body-file`) stay relative to the working directory.
`init-project.mjs`, `setup-skills.mjs` and `affected-tests.mjs` take the same first argument (`takeCwd` in `checkout-root.mjs`),
and then work in that directory, their relative paths (changed files given to `affected-tests.mjs`) included.

`board.mjs help` lists the commands and `board.mjs help COMMAND` shows one of them (usage, flags, what it does; 0.3 to 1 KB). `--help` or `-h` after a command does the same,
without calling GitHub. A call the description of a command does not allow (an unknown flag, a missing or malformed value, a word too many) is refused with the reason and the usage of
that one command (exit 2) before anything is read or written. The table is generated from the descriptions in `scripts/board-*.mjs` (`node scripts/board-readme.mjs`);
the long text of a command is in [docs/board](docs/board).

<!-- board-commands:start -->
| Command | Access | What it does |
| --- | --- | --- |
| `start ISSUE [--session ID] [--takeover] [--base BRANCH] [--issue-repo OWNER/NAME]` | writes | Claims a Ready issue. Runs the execution check, then assignment, In progress and the claim comment, each write read back. A repeated call resumes. [Details](docs/board/start.md) |
| `done ISSUE [PR] [HANDOFF_FILE] [--refs] [--no-pr] [--max-minutes N] [--skip-local-tests REASON] [--issue-repo OWNER/NAME]` | writes | Everything from the last push to Human review. Steps: tests, PR ready, acceptance boxes, Automated review, wait for CI and reviewers, handoff comment, gate. A repeated call does what is still open; without HANDOFF_FILE it only prepares. [Details](docs/board/done.md) |
| `next [--session ID]` | reads | Lists what to do next. In this order: feedback on your issues, your unfinished work, stale work, the Ready issues. [Details](docs/board/next.md) |
| `sweep` | writes | Cleans up the board. Human-review issues whose PR has merge conflicts go back to Automated review; issues whose PR merged into release/** are closed. [Details](docs/board/sweep.md) |
| `threads PR [--resolve NUMBER ...] [--reply TEXT]` | writes | Lists the open review threads of a PR (number, author, file and line, outdated or not, link). With --resolve it closes exactly the threads you name, nothing else. [Details](docs/board/threads.md) |
| `field ISSUE NAME VALUE [NAME VALUE ...] [--field NAME=VALUE ...] [--spec-review]` | writes | Sets single-select Project fields (Status and Priority too). All pairs are checked before the first write and read back together. NAME VALUE and --field NAME=VALUE mean the same. [Details](docs/board/field.md) |
| `new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--status S] [--field NAME=VALUE ...] [NAME VALUE ...] \| new --from FILE` | writes | Creates an issue with its required metadata in one call, or many with --from. Everything is checked first and read back. Extra fields: NAME VALUE or --field NAME=VALUE. [Details](docs/board/new.md) |
| `block ISSUE BLOCKER` | writes | Marks ISSUE as blocked by BLOCKER (N, #N or OWNER/REPO#N). [Details](docs/board/block.md) |
| `sub PARENT CHILD` | writes | Makes CHILD (N, #N or OWNER/REPO#N) a native sub-issue of PARENT, read back. An existing link succeeds again. [Details](docs/board/block.md) |
| `wait PR [--merged] [--stall MINUTES] [--grace MINUTES] [--head SHA] [--max-minutes N] [--interval SECONDS]` | reads | Waits until CI and every reviewer of the PR head have finished. Exit 0 done, 1 red CI, 3 waiting, 4 call again, 2 error; prints blockers and Sonar issues. [Details](docs/board/wait.md) |
| `quota-wait [--max-minutes N]` | reads | Waits for the shared GraphQL quota. Returns once it has 300 points again, sleeping until the reset (exit 4 if that is after --max-minutes). [Details](docs/board/quota-wait.md) |
| `merge PR [--stack] [--stall MINUTES] [--grace MINUTES] [--interval SECONDS] [--max-minutes N]` | writes | Merges a PR (the only way for an agent with merge authority). It applies the gates of `done`, waits for CI and reviewers, merges the checked head and reads the merge back. [Details](docs/board/merge.md) |
| `stack-sync TOP` | writes | Brings a PR stack up to date. Merges the base into each layer of the stack of PR TOP, bottom first, and pushes (no rebase, no force-push). A conflict stops it. [Details](docs/board/stack-sync.md) |
| `body ISSUE FILE BASE_FILE` | writes | Replaces the issue body with FILE. Only if the current body still equals BASE_FILE; read back after. A body that changed meanwhile is refused with a diff. [Details](docs/board/body.md) |
| `body-replace ISSUE --from FILE --to FILE` | writes | Replaces one occurrence of a text in the issue body. The text in --from becomes the text in --to; written and read back like `body`. [Details](docs/board/body.md) |
<!-- board-commands:end -->

- Cost of a call: `BOARD_TRACE=1 node scripts/board.mjs …` prints one `gql COST QUERY` line per GraphQL request to stderr. The Project's
  field and option ids are cached in the clone's Git directory (`board-project-fields.json`, shared by worktrees) and read again only when a
  name or option is missing or a write with them fails; `BOARD_FIELD_CACHE=0` switches the cache off. Delete the file after recreating a field.

### Handoff comment

`done` needs one comment on the PR from the driver (the authenticated GitHub user) that
has the handoff heading on its own line (`## Handoff`, or `## Übergabe` with `"language": "de"` in [the project file](SETUP.md#3-board-and-labels)) and a line `Head: <SHA>` that starts with the
first seven characters of the PR's current head commit. The comment names the head it is
about, so no timestamp is involved: a new head, for example after a review fix, asks for a new
comment, a comment for an earlier push does not count, and it works the same for a head without
a check suite or one that was pushed and checked on another branch first. Put the retro under
the heading `Retro` (any level, usually `###`), one list line per finding, and, after another
heading, the review findings with their disposition and, if a reviewer was unavailable or
stalled, the reviewer, cause and evidence (an optional reviewer only when it found something). Without findings the retro has the single line `No findings` (`Keine Funde` with `"language": "de"`).
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
  if that state has the kit gitlink, only `git submodule update --init .vendor/workflow-kit` runs first; without a gitlink `.vendor/workflow-kit` becomes a link
  (Windows junction, else symlink, as in the session hook) to the kit checkout that runs `board.mjs`. Bash is Git for Windows' `bash.exe` on Windows (derived from `git --exec-path`, not the WSL one), `/bin/bash` elsewhere.
- `awaitApps`, `optionalReviewers`, `updateBranchChecks` and `ignoredChecks` are read from `.github/workflow-project.json` on the PR's base branch at each look (GitHub contents API),
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

## Clean up finished worktrees

`node .vendor/workflow-kit/scripts/worktree-gc.mjs` is a dry run: it counts the worktrees of the project, which ones are
finished and why the others stay. `--rm` deletes the finished ones in parallel (8 at once; `rd /s /q` on Windows), their
local branch, and calls `git worktree prune`. `--list` prints one line per worktree.

A worktree is finished only if it has no local changes, no commit missing on the remote (a commit that a closed or merged PR
ended on counts as saved), no running process, no lock of a living session, and is older than `--min-age` (120 minutes).
Whatever is unclear stays. Ignored files (`node_modules`, local `.env`) do not count as changes and go with the worktree.

A driver removes its own worktree after its PR is merged: from the main checkout, `worktree-gc.mjs --rm --only <worktree>`
(the lock and age checks are skipped for that one worktree, the safety checks are not).

Docker volumes named `<prefix><sha256(root)[0:12]>[-suffix]` (the project's `"worktreeVolumePrefixes"` in
`.github/workflow-project.json`, for example `["gradle-cache-"]`; the hash is of the checkout path) are shown, and
with `--rm` deleted, once no worktree has that root any more. A name containing a word of `"worktreeVolumeProtect"` (the
project's long-lived volumes, also `--volume-protect`) is never touched; a volume in use
is refused by Docker and stays.

## Developing the kit

```sh
git submodule update --init --recursive    # the tests clone the pinned submodules
node scripts/init-project.mjs --existing
node scripts/setup-skills.mjs --refresh
git status --short    # review intended outputs; preserve unrelated work
node --test scripts/tests/<affected>.test.mjs    # add --test-name-pattern for one test
node scripts/affected-tests.mjs    # test files for the changed files (--run runs them); new scripts need a row in its table
```

The agents the kit serves are listed once, in `scripts/agents.mjs` (skill folder, agent-definition folder, hook file and hook shape per agent); the setup scripts and `init-project` read only that table, and the hook settings of `.claude/settings.json` and `.codex/hooks.json` are generated from it with the command texts of `scripts/hook-commands.json`. `detect` lists the project paths that show an agent is in use (`.claude`, `.codex`); `kit setup` writes hooks only for those agents and, when none is found (a new project), for all of them and says so. A new agent is a new entry plus its regenerated files; the CI regeneration diff covers them.

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
`scripts/provider.mjs ponytail update` and `scripts/provider.mjs impeccable update` as needed, then the CI
generators, pushes the result to the Renovate branch and approves the repository CI and CodeQL runs for the
new head: a push with `GITHUB_TOKEN` makes GitHub create the `pull_request` runs but hold them as
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
(no secrets or contents write; CodeQL can upload security events). The job approves only the
`pull_request` runs of `repository.yml` and `codeql.yml` for the commit it pushed (each list is
asked for that commit), waits up to two minutes per workflow and fails when either never appears.
Commit author names prove nothing,
so the bot-author rule only leaves branches with other people's commits alone. If the approval
fails, approve the held run on the pull request ("Approve and run") or restart it:
`gh run rerun <id>`. `renovate.json` lists the bot's commit address in
`gitIgnoredAuthors`, so Renovate keeps updating the branch. Submodules are not fetched at
checkout: the job first requires the submodule URLs in the branch's `.gitmodules` to equal
main's and fails otherwise, so a branch cannot point the generators at another repository.
`provider.mjs ponytail update` keeps its conflict files in `.workflow-kit/ponytail-resolve/` and
refuses to read, write or delete there when any part of that path is a link.

When upstream edits lines our Ponytail adaptations rewrite, the job fails and names the files.
Run `node scripts/provider.mjs ponytail update` on the Renovate branch: it writes the conflicting
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

Dependabot security updates use the same protected merge queue, including major updates.
The metadata-only workflow never checks out pull-request code. The ruleset also requires
CodeQL; GitHub secret scanning, push protection and private vulnerability reporting are enabled.
