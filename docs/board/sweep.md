# board.mjs sweep

`sweep` (merge loop or chief session, at their usual rhythm): sets every Human-review issue whose open PR has merge conflicts (DIRTY) back to Automated review with a comment, and closes every open issue whose linked PR (same repository) is merged into `release/**` (GitHub closes only for the default branch) with a comment, unless a human reopened it after the merge (then it stays open and is named), one line each, else `clean`; see [parallel-drivers.md](../parallel-drivers.md).
To run it without a person, copy [docs/board-sweep.yml](../board-sweep.yml) to `.github/workflows/board-sweep.yml`: it runs `sweep` on every push to
the PR bases (`main`, `release/**`; adjust) and hourly. It needs the secret `BOARD_TOKEN` (a token that may write the Project and issues; `GITHUB_TOKEN` cannot).
The reset issues then show up in `next` as stale work (below).

A stopping error (used-up quota, unreadable read) ends `ERROR` with exit 2, like in `next`, `block` and `sub` (`check` says `UNKNOWN`); `sweep` then names the issues it had already closed. Exit 1 stays for skipped issues.
