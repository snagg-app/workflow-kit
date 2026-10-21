# board.mjs field

`field ISSUE NAME VALUE [NAME VALUE ...] [--spec-review]`: any single-select fields (Status and Priority too), all read back together after writing.
Every pair is checked against the field definitions before the first write: one invalid pair writes
nothing and names the valid options. It reports failures as one `ERROR - reason` line (exit 2, nothing else printed), not a stack trace.
Issue read errors name `OWNER/REPO#N`. `Status "In progress"` needs a startable issue assigned to you, `Status Ready` no decision wait, `Done` is
refused for a spec. Every spec status write needs `--spec-review`, used only by a human-invoked `spec-review`; Human review reads every sub-issue over REST immediately before writing and refuses open or unreadable children.
`Status "Automated review" PR [OTHER_ISSUE...]` verifies the backlinks as `done` does. `start` and `done` leave specs untouched and set task status themselves;
`field` is metadata maintenance.
