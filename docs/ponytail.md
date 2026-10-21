# Ponytail

Source: `.vendor/ponytail`, pinned upstream release (MIT), plus
`scripts/ponytail/adaptations.patch`: repository tests, help/debt text and hook
host/state handling ([provenance](../scripts/ponytail/NOTICE.md)).
For discovery paths, reviewed regeneration and preserved local changes, follow
[generated files](../README.md#generated-files-and-ownership).

Skills: `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`,
`ponytail-gain`, `ponytail-help`. The gain figures are upstream benchmarks, not
measurements from this project. If a personal Ponytail plugin is also enabled,
choose one source in the agent's settings.

## Hooks

Follow [hook installation and trust](../README.md#hooks).
`install-ponytail-hooks.mjs` copies generated hooks to
`~/.ponytail/workflow-kit/<version>/`, refusing destinations inside any Git checkout.
Its `launch.sh` and `launch.cmd` use the installer's absolute Node binary:

- The launchers never search PATH and never run checkout files. Only the SessionStart bootstrap
  `scripts/ensure-hooks.mjs` runs from the checkout with the PATH Node, to install what is missing
  (Milan, 21.10.2026, [#666](https://github.com/snagg-app/workflow-kit/issues/666)).
- `NODE_OPTIONS` and `NODE_PATH` are cleared.
- A Node inside a checkout is refused.
- If that Node is removed later, SessionStart reports the hooks as off and reinstalls them for the next start.
- The installers list older installations they no longer need; they never delete them.

Snapshots are immutable per version; changed same-version snapshots are refused.
New versions change hook commands and need trust again. Execution policies stay
unchanged; no PowerShell script file runs.

Codex uses its session shell for hooks. Its Windows commands support the default
PowerShell session and pipe JSON stdin through the absolute system `cmd.exe` to
the existing launcher, preserving its exit code. Select PowerShell for Windows
Codex sessions; these commands are not standalone CMD snippets.

| Host | Events |
| --- | --- |
| Codex, Claude Code | SessionStart, UserPromptSubmit, SubagentStart |

`launch.cmd` is a cmd/sh polyglot.

Mode is stored per Git checkout and host in the Ponytail config directory.
`/ponytail lite|full|ultra|off` switches it, and `/ponytail default <mode>` saves a
personal default. Bare `/ponytail` enables the default level when off (full if the
default is off), or reports an active level. Resume/compact preserves the live
mode. Version 5.2.0 uses snapshot `5.2.0-1`; install and trust the new hook
commands explicitly. Previous snapshots stay intact.
`node --test scripts/tests/ponytail-hooks.test.mjs` runs the
real manifest commands with hostile PATH entries; agent loading/trust needs
separate verification.
