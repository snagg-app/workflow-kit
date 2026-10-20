# Impeccable

Source: `.vendor/impeccable`, pinned to `skill-v4.6.0` and used unchanged.
`scripts/impeccable/` holds the hook engine's `VERSION` and `SHA256SUMS`.
Follow [generated files](../README.md#generated-files-and-ownership) for reviewed
updates and discovery paths, including Codex and Claude agents. Consumer
`PRODUCT.md` and `.impeccable` settings stay in the project.
Exclude generated third-party skills and companions in every provider from static analysis.

## Coupled updates

After proposing the official `skill-v` tag and gitlink, run one command from the
kit checkout:

```sh
node scripts/update-impeccable.mjs
```

It reads the engine version from both pinned skill packages, checks the
official engine release and all five platform digests against their checksum
files, and validates every metadata target before writing. Then it stages the
validated gitlink for the existing generators and refreshes engine pins, fixed
hook paths, documentation, skills and companions. It never executes vendored
programs or installs a personal engine. Review and commit the complete diff.
The installer still uses only the accepted kit pin; it never resolves `latest`.

`renovate.json` limits this post-upgrade command to `.vendor/impeccable`, once per
update branch, with explicit output filters. Node comes from Renovate's tool
runtime; no GitHub CLI or personal credential is needed. Configuration alone
does **not** make the command executable on Mend-hosted Renovate.

### Mend admin prerequisite

On 2026-10-05, the [live job](https://developer.mend.io/github/vaultdex/workflow-kit/-/job/24630893-e4f9-4d04-96b2-8bb5c19467e8)
showed Community (Free), Renovate 44.125.1, and only `^git add --all$`,
`^git reset$`, `^pwd$` in `allowedCommands`. The generator is blocked.
According to the [Mend FAQ](https://docs.renovatebot.com/mend-hosted/faq/#how-can-i-run-arbitrary-commands-through-postupgradetasks),
Free users cannot request arbitrary commands. An org admin must first request
Community (OSS) eligibility for the MIT-licensed `vaultdex/workflow-kit`, then
ask Mend to allowlist exactly `^node scripts/update-impeccable\.mjs$` for this
repository. OSS acceptance and command approval are Mend's decisions.

Prepared [Mend Hosted Request](https://github.com/renovatebot/renovate/discussions/new?category=mend-hosted-request)
text, for the org admin to submit:

> Please assess vaultdex/workflow-kit (https://github.com/vaultdex/workflow-kit,
> MIT) for the Community (OSS) plan and allowlist
> `^node scripts/update-impeccable\.mjs$` for this repository. This command
> completes only official Impeccable skill updates: it reads upstream files as
> data, validates five public engine artifacts and checksums, and runs our
> existing generators. It makes six public HTTPS metadata reads per update,
> plus the pinned Git checkout/tag fetch when needed, and executes no
> vendored program, needs no additional secret, and installs no personal engine.
> Renovate collects only the explicit output paths in our package rule. Local
> execution takes about 10 seconds; no additional Actions job is requested.

After approval, read back the exact `allowedCommands` entry in a new Mend job.
Exercise a real Impeccable update, verify the command ran successfully before
Renovate committed, and inspect all pins and generated outputs in the same PR.
Require repository CI on that head and repeat generation to prove no drift.
Until that live proof exists, the automation criterion in
[issue #83](https://github.com/vaultdex/workflow-kit/issues/83) remains open.
Do not treat a skipped or forbidden command as a successful update.

## Hooks

Follow [hook installation and trust](../README.md#hooks). Hooks run only the
engine installed by `install-impeccable-hooks.mjs` in
`~/.impeccable/vaultdex/engine-<version>/`, verified against `SHA256SUMS` even when
reused. Without it, SessionStart prints an install hint; edit/Stop hooks stay
silent without claiming analysis. Engine 0.1.15 analyzes only session-touched files at Stop.
After an update, explicitly install the reviewed engine and trust the updated hook
commands. Older engine directories remain untouched; the fixed hooks use only
the newly pinned version.

The skill's own CLI launcher (`scripts/impeccable`) downloads its engine on first
use and checks it against the release's checksum file. If two first starts on
Windows collide, run the command again.
