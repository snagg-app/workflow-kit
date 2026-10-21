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
  The fake refuses a query that asks for a field the recorded real GitHub answers (`scripts/tests/gh-shapes/*.json`) lack: add the
  field to `gh-shapes/probes.json`, then renew the recordings with `node scripts/record-gh-shapes.mjs --issue N --pr N`
  (read-only, repeatable flags; names and texts never reach the files). A mutation cannot be recorded without writing, so it is not checked.
  Every `gh` call, the GraphQL quota logic and the field cache live in `scripts/github.mjs`; the worker gives it the fake with `useGhAdapter`.
- Tests write only in their own temp directories, never in the checkout (`.git/modules`), so
  concurrent runs stay green; `scripts/tests/fixtures.mjs` has the helpers. Slow Git scenarios
  run side by side (async, own repos) instead of one after another.
- Add no npm dependencies, installers that run without an agent or human invoking
  them, secrets or private product content. The [hook rule](AGENT_RULES.md#hooks)
  authorizes agents to invoke the two existing installers; no hook or script may,
  except the hook module `scripts/kit-hook.mjs` (Milan, 21.10.2026, #666), which starts them detached at SessionStart.
  The commands the hook module and its entries run themselves are `git merge --ff-only` (a clean project checkout
  without own commits, to the last fetched base), `git clone` of the shared kit when it is missing, and
  `git pull --ff-only` with `git submodule update --init` in that shared checkout (on `main`, clean, nothing unpublished).
  After a clean check the module writes a stamp `kit-ok` into the git dir of the checkout; while project commit, kit commit and kit path are unchanged and the stamp is under 10 minutes old (`KIT_HOOK_FRESH_SECONDS`), it skips the check and the pull (#689).
