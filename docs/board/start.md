# board.mjs start

`start ISSUE [--session ID]`: everything from Ready to the claim (assignment, In progress, claim comment), each write read back; a repeated call resumes (a step already
done is skipped). The session is `--session`, else the `sessionEnv` variable of an agent whose session is marked by `detectEnv` in `scripts/agents.mjs` (`CODEX_THREAD_ID`), else the `agent-<id>` of a Claude Code worktree,
else the `sessionEnv` variable of the other agents (`CLAUDE_CODE_SESSION_ID`). It starts with the execution check of the issue, printed (exit 0 STARTABLE, 1 BLOCKED, 2 UNKNOWN, 4 STACKABLE:
only an open predecessor PR holds the issue, see [Stacked pull requests](../CONTRIBUTING.md#stacked-pull-requests)); BLOCKED and
UNKNOWN write nothing. The check shows the open PRs with the session their claim names and one line per native sub-issue; with
`"baseBranch": {"field": "Zielrelease", "pattern": "release/{value}"}` it also prints `base: release/0.1.1 (Zielrelease)` from that
Project field (an optional `"values": {"main": "main"}` names a fixed branch for such field values instead of the pattern) and a `note:`
when the value is no branch name, `origin/<base>` is unknown locally or git cannot answer, or `HEAD` does not descend from
`origin/<base>` (that last one only for an issue with no branch yet and no stack); no fetch, never a verdict. Then `start`:
sets `submodule.recurse true` and `push.recurseSubmodules no` in the clone (only with a `.gitmodules`) and `push.default simple`, assigns the authenticated user,
sets In progress and posts the claim comment (`Agent: NAME, Session: ID` and `Basis: BRANCH` (`Base: BRANCH` in an English project; both are read), the base: the base PR's branch of a stack,
else the Project base field, else the default branch). It creates no branch and no PR: the first `done` pushes your branch
(`<agent>/<number>-<title>`, or the checkout's own branch of that shape) and opens the Draft PR (`Closes #N` and the claim line) with its native link.
When the branch already has an open PR that the issue does not list yet, `done` reuses and links it instead of opening a second one (GitHub answers 422, #725).
An issue that already has an open PR (a takeover, a resume) continues on that PR's branch (`git switch`). Then it runs `git fetch origin`, brings the kit to its pin, and
last the optional `"setup"` shell command of `.github/workflow-project.json` (for example `"node scripts/bootstrap.mjs"`, run like a `push` command, in the checkout, with `BRANCH`);
if it fails, `start` ends with an error and the output, claim and status stay, and `start` again resumes. The claim holds the issue for every session whose ID it does not name; once the PR exists, its body line is the claim. Keep the claim
line when you rewrite the PR body. It ends with
`START #N session … base … (claim only …)`, or `… branch … base … PR #…` with an existing PR; for a stack it names the PR to link above. Abandoned work (below, `next`) is taken over
with the same call: `start` writes the new session into the claim line of its PR, or posts a new claim comment. A handover is the same edit of the claim line by hand. A new start is BLOCKED with `finish #N first` while you have an own unfinished issue (a resume or a stack on its work is not).
