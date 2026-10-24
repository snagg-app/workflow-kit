# board.mjs threads

`threads PR` lists the open review threads of a PR and writes nothing. One line per thread:
`thread NUMBER @author file:line outdated: yes|no - first line of the finding - link`.
NUMBER is the id of the thread's first comment, the digits at the end of its link (`#discussion_rNUMBER`). The `thread <link>` lines of `wait`, `done`, `handoff` and `merge` name the same number.
One query reads all threads of the PR, resolved ones too.

`threads PR --resolve NUMBER... [--reply TEXT]` closes exactly the threads you name (repeat `--resolve` for several), after an optional reply in each, and reads the state back from GitHub.
It writes nothing when one number is not a thread of this PR (a typo, or a thread of another PR). A thread that is already resolved is named and left alone.
There is no "close all" and no "close all outdated": whether a finding is fixed is your decision, so name the threads you checked.
A reply needs `--resolve`.
