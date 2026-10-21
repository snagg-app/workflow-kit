# board.mjs stack-sync

`stack-sync TOP`: for the native stack of the top PR TOP, merges from the bottom layer up the base into each layer (`git merge`, no
rebase, no force-push) and pushes it, in a temporary worktree of this checkout. A real conflict stops it with `blocker:`, the layer and the
files; the merge stays open in the printed worktree. Run it after a lower layer got conflicts or the base moved.
