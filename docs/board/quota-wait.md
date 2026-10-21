# board.mjs quota-wait

`quota-wait [--max-minutes N]`: returns (`DONE` with the `quota: …` line, exit 0) once GitHub's shared GraphQL quota has
300 points again, sleeping until the reset taken from the response headers; a pause that would end after `--max-minutes`
(default 9) is not slept through: it ends `still waiting: call quota-wait again after <time>` (exit 4). Use it, or `wait`, instead of a loop of your own around `gh`:
a refused `gh api graphql` prints the error and may still exit 0.
