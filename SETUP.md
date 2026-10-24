# Setting up a repository

For kit setup/update requests. Use kit scripts and deliver a verified PR. Ask only
for missing decisions, access or approvals; never request credentials in chat.

## 1. Agree on the target

Read any existing target AGENTS.md and contribution rules; inspect its remote,
Git status, board, CI, update bots and agent configuration. Confirm the target, which may
differ from this checkout. Resolve only missing choices in one compact round:

- **Repository:** a new one (from your own template repository or empty), or an existing
  one? Get the exact OWNER/REPO and local path. For a new one, also the owner, name
  and visibility; recommend private.
- **Board:** an existing GitHub Project number under the same owner, or a copy of
  the kit's template board?
- **Tools:** which agents (Codex, Claude Code) and
  reviewers (CodeRabbit, Codex), and which of them are optional
  (`"optionalReviewers"`, see [section 3](#3-board-and-labels))? Which updater: the existing Renovate or
  Dependabot, never both? Optional Sonar?
- **Start policy:** does every start need an explicit human request (the
  default), or does a human placing an issue in Ready count (`"start": "ready"`)?

New paid usage, such as Actions on private repositories or reviewer plans, needs
the user's budget decision first.

## 2. Repository

For a new repository run
`gh repo create OWNER/REPO --private` (add `--template OWNER/TEMPLATE` for a template of yours), then
clone it with `--recurse-submodules`.

With a working kit and `.github/workflow-project.json`, follow
[Start or resume](AGENT_RULES.md#start-or-resume) before setup edits.

**First installation:** the explicit setup request authorizes only bootstrapping
the missing kit/Project binding. Follow existing project rules; create or reuse
the setup issue and its linked branch, switch to it, assign yourself and record
your session, scope and unavailable checks or metadata before editing. Verify
ownership and native/external prerequisites; missing tooling is not STARTABLE
and does not waive blockers or unreadable dependencies.
Limit edits to establishing the kit and board below, then complete the normal start.

Add the kit only if absent. Run `kit setup` from the
[install section](README.md#install-or-update-in-a-project); it also covers the board
and hooks below as far as `gh` allows, and ends with the steps left for a person.
Preserve project rules, templates and CI.

Link `.vendor/workflow-kit/AGENT_RULES.md` from root AGENTS.md: about 20–40 lines
of project facts and routes to build/tests, architecture, final proof and exceptions.

## 3. Board and labels

Before reusing a board, configure exactly Backlog, Ready, In progress, Automated
review, Human review, Done, plus a usable Priority scale. Migrate In review by
renaming it to Automated review in place and adding Human review before Done;
preserve option IDs, cards and existing Priority, including organization fields.

`kit setup` binds the board for the `origin` remote (the same as `setup-github.mjs OWNER/REPO`); for another board call
`node .vendor/workflow-kit/scripts/setup-github.mjs OWNER/REPO PROJECT_NUMBER` yourself.
It copies or reuses the Project and records it in `.github/workflow-project.json`,
keeping `"start"`. A new board is a copy of `"boardTemplate"` (`{"owner": "ORG", "number": 5}`); without it the kit copies its own board (the one in the kit repository's own `.github/workflow-project.json`). It also checks the six statuses and Priority, links the
repository, and adds the missing labels, by default: ci, documentation, testing,
security, dependencies, needs-human-input, spec. `"labels"` (`[{"name": "ci", "color": "1d76db"}]`) replaces that list.

If field validation fails, correct that board and repeat the same command; a
copied board is already recorded, so do not create a replacement. Write and verify
the agreed policy: `"start": "ready"`, or omit `start` for explicit requests.
The script preserves an existing policy rather than choosing one.

If an analyzer reports through a GitHub App that creates its check only when it
finishes (SonarCloud), list the app slug in `"awaitApps"`, for example
`"awaitApps": ["sonarqubecloud"]`, so `board.mjs wait` waits for it. A review bot the
project does not depend on (CodeRabbit on a free plan that is mostly rate limited) goes in
`"optionalReviewers"`, a list of bot logins or app slugs, for example
`"optionalReviewers": ["coderabbitai"]`: `board.mjs wait` and `done` never
wait for it or call it stalled, and agents neither re-request nor replace its review.
Its findings, open threads and change requests still count, and its 👀 reaction is
shown as a note. An analyzer such as SonarCloud listed there still reports its open issues
as a blocker, because they are findings, not waiting. A `null` or other non-list value is an
ERROR; omit the field instead. A check that only asks for the base to be merged (the retarget restart check of a
stacked PR) goes in `"updateBranchChecks"`, a list of check names: `board.mjs merge` then merges the base into the PR
branch instead of ending `FAILED`. A check that is not authoritative for the project (for example a GitHub-owned
check that cannot run without Actions budget) goes in `"ignoredChecks"`, a list of check names: `wait`, `done` and
`merge` show it as `[ignored: listed in ignoredChecks]` and neither await it nor count it red; every other red check
stays `FAILED`. The script keeps these settings too.
`"doneBaseMerge"` selects the project's rule for the first untested `done` head:
`"always"` (the default, also when omitted) merges the fetched PR base before tests;
`"overlap"` merges only when both sides changed a path since their merge-base or Git
detects a conflict, including directory/file conflicts. Unrelated changes leave the
pushed head intact. Rename/delete paths are compared without rename folding and
without the GitHub file-list cap. The setting is read from the current PR target
branch, never the checkout; another value or an unreadable comparison fails closed.
The conflict probe uses Git's `merge-tree --write-tree` (Git 2.38 or newer).
Both modes keep the exact-head tests, CI/review gates and tested-head resume behavior.
`board.mjs wait` and `done` also keep waiting a few minutes after Ready and after each push, because a
review bot may start late (`"reviewerGraceMinutes"`, default 3). The wait ends sooner when a required bot has answered on
the head, a limit notice included. A project whose bots do not start on their own sets
`"reviewerGraceMinutes": 0`; a non-number or negative value is an ERROR.
`"staleHours"` (default 6) is how long work may lie without any activity before `board.mjs next` lists it as abandoned and `start` lets a new
session take over its PR; a non-number or negative value is an ERROR. The automatic `sweep` is the opt-in workflow [docs/board-sweep.yml](docs/board-sweep.yml).
`"specLabel"` (default `spec`) names the label of a spec: `board.mjs` never closes it and always refuses Done. Every status write needs `field --spec-review`, used only by a human-invoked `spec-review`; Human review also refuses while any sub-issue is open (fresh REST read immediately before writing). The skill hands off only if its run created or linked no sub-issue. A PR text with a closing keyword for a spec fails `done`.
`"selfReview"` lists the self-checks the PR body must name in its self-review section (`## Self-review`, with `"language": "de"` `## Selbstprüfung`) before
`board.mjs done` or `merge` passes, for example `"selfReview": ["ponytail-review", "code-review"]`; omit it to ask
nothing. A `null` or other non-list value is an ERROR.
`"language"` (`en` by default, or `de`) is the language of the headings and comments `board.mjs` writes and looks for: the handoff heading (`## Handoff` or `## Übergabe`), the self-review section, the claim comment, the `next` and hook hints, the sweep comments and the issue and PR templates `init-project` creates for a new project (`templates/<language>/`).
`"skills"` lists the kit skills the project uses, for example `"skills": ["core", "tdd", "impeccable"]`; `"core"` stands for the ten core skills, which are also all you get when it is omitted (why these: `docs/skill-core.md`), and `"all"` keeps every kit skill. `setup-skills` (also run by `kit setup`) removes the other kit skills again, so agents list fewer descriptions (47 skills are about 2,400 tokens; the core is about 700). `kit setup` also names skills you have as a plugin and the list that leaves the project copy out. A name that is no kit skill is an ERROR; skills of the project itself are never touched.
`"impeccable"` (`true`, `false` or `"auto"`, the default) and `"ponytail"` (`true`, the default, or `false`) choose which hooks and downloads the project gets. A project without Impeccable has no `PostToolUse` or `Stop` hook entry (no UI check after every edit) and never downloads the 19 MB engine; without Ponytail it has no `UserPromptSubmit` entry and no Ponytail install. `"auto"` switches Impeccable on when the project has UI files: a `.tsx`, `.jsx`, `.vue`, `.svelte` or `.astro` file, or a UI framework (React, React Native, Expo, Vue, Svelte, Solid, Preact, Lit, Angular, Next, Astro) in the dependencies of any `package.json`, among the files Git tracks or would add. If that guesses wrong, set `true` or `false`. The next `init-project` or `kit setup` adds or removes the hook entries to match; an installed engine stays on disk.
`"statuses"` renames board statuses for `board.mjs` and `setup-github.mjs`: keys `backlog`, `ready`, `inProgress`, `automatedReview`, `humanReview`, `done`, for example `"statuses": {"humanReview": "QA"}`; the board still needs all six, in that order.
Likewise `"requiredFields": ["Size"]` names Project fields that
`board.mjs new` demands besides Priority.

For first installation, add the setup issue to this Project, complete its
[metadata](docs/CONTRIBUTING.md#issues), and set Ready under the explicit setup
request. Now complete [Start or resume](AGENT_RULES.md#start-or-resume) before
continuing. Failed checks stop dependent work; never label bootstrap as a passed check.

Finish and verify these settings in the Project and repository; Project workflows
require UI configuration:

- **Automation:** auto-add `repo:OWNER/REPO is:issue` to Backlog. Disable
  automations that move items to Ready or In progress on PR links or bot events,
  and any that set Human review from PR readiness or CI. Not-planned closures must
  not become Done.
- **Metadata:** a new project-local Priority field gets Urgent, High, Medium, Low.
  Show Labels and Milestone.
  Create the milestone `Hotfixes · laufend` if the project takes hotfixes.
- **Reviewers:** enable only the chosen reviewers (CodeRabbit needs App
  authorization; Codex needs automatic reviews enabled), then verify each on the
  setup PR. Committed configuration doesn't install an App. Analyzers must exclude generated
  third-party skills and companions in every provider's discovery paths.
- **Rules:** require PRs, human approval and always-reported checks, never a
  path-filtered check that can be absent. If rulesets are unavailable (HTTP 403 on
  the plan), report it; don't change the plan or the visibility.
- **Updater:** add GitHub Actions updates to the existing
  Renovate rules, or use the template's Dependabot file.

## 4. Agents and hooks

`kit setup` installs the hooks for both agents; personal trust remains required ([Hooks](README.md#hooks)).
It also runs [install-git-hooks.mjs](README.md#git-hooks) for projects with `.githooks/`; a rerun is what updates a clone's hooks.
Report each integration as enabled, untrusted or unavailable.

## 5. Deliver

Commit intended configuration and follow [Commit generated files](README.md#commit-generated-files),
including all provider discovery files and executable modes; exclude personal settings, staging
bundles, backups and credentials. Verify a plain clone discovers ordinary skills
and companions without setup. Verify snapshots and agent trust separately.
Then follow [Delivery](docs/CONTRIBUTING.md#delivery) through checks, automatic
reviews and findings to human handoff. Finish with:

- links to the repository, board and PR,
- what was verified,
- the remaining user-only steps: App authorization, hook trust and the merge.
