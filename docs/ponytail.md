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
`~/.ponytail/vaultdex/<version>/`, refusing destinations inside any Git checkout.
Its `launch.sh` and `launch.cmd` use the installer's absolute Node binary:

- Hooks never search PATH and never run checkout files.
- `NODE_OPTIONS` and `NODE_PATH` are cleared.
- A Node inside a checkout is refused.
- If that Node is removed later, rerun the installer.

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
| Copilot | sessionStart, userPromptSubmitted, subagentStart |
| Cursor | sessionStart, beforeSubmitPrompt |

Cursor's existing always-on Ponytail rule takes precedence. Its sessionStart hook
uses one Windows/POSIX command: a Bash/PowerShell
[polyglot](https://shogo82148.github.io/blog/2021/12/30/polyglot-of-bash-and-powershell/),
and `launch.cmd` is a cmd/sh polyglot.

Mode is stored per Git checkout and host in the Ponytail config directory.
`/ponytail lite|full|ultra|off` switches it, and `/ponytail default <mode>` saves a
personal default. Bare `/ponytail` enables the default level when off (full if the
default is off), or reports an active level. Resume/compact preserves the live
mode. Version 5.2.0 uses snapshot `5.2.0-1`; install and trust the new hook
commands explicitly. Previous snapshots stay intact.
`node --test scripts/tests/ponytail-hooks.test.mjs` runs the
real manifest commands with hostile PATH entries; agent loading/trust needs
separate verification.
