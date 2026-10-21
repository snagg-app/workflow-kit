# Workflow Kit contributors

Follow [AGENT_RULES.md](AGENT_RULES.md); here the kit itself is the project, so
kit paths drop the `.vendor/workflow-kit/` prefix (`node scripts/board.mjs start 123 --session ID`).

- Skills use pinned submodules, reviewed `scripts/` patches and the canonical
  `.agents/skills/find-skills` snapshot. Update its source notice with its upstream
  pin. Kit-owned skills (`spec-review`) are edited in `.agents/skills/` only;
  never edit generated provider copies.
- After scripts, templates or patches change, run [Developing the kit](README.md#developing-the-kit)
  and [Commit generated files](README.md#commit-generated-files), including executable modes.
- Tests cover behavior that protects users (no checkout code in hooks, no lost
  files, board verdicts), never wording. Don't add tests for text or upstream logic.
- Fresh clone: run `git submodule update --init --recursive` before the tests; they stop with that line if it is missing.
- Board tests: add a case to the file of its command (`scripts/tests/board-<command>.test.mjs`), helpers in
  `board-fixture.mjs`. `board.mjs` runs in a worker with a fake gh (`fake-gh.mjs`), not as a process per call.
  Every `gh` call, the GraphQL quota logic and the field cache live in `scripts/github.mjs`; the worker gives it the fake with `useGhAdapter`.
- Tests write only in their own temp directories, never in the checkout (`.git/modules`), so
  concurrent runs stay green; `scripts/tests/fixtures.mjs` has the helpers. Slow Git scenarios
  run side by side (async, own repos) instead of one after another.
- Add no npm dependencies, installers that run without an agent or human invoking
  them, secrets or private product content. The [hook rule](AGENT_RULES.md#hooks)
  authorizes agents to invoke the two existing installers; no hook or script may.
  The two commands a hook runs itself are `git merge --ff-only` (a clean checkout without own commits,
  to the last fetched base) and `git submodule update --init .vendor/workflow-kit` (for a missing or
  lagging kit, and from the Git `post-checkout` hook after a branch checkout).
