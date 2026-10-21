# board.mjs new

`new --title T --body-file FILE --milestone M --label L [--label L ...] --priority P [--status S] [--field NAME=VALUE ...]`:
create an issue with its required metadata in one call and print one line, `NEW URL | milestone | labels |
Status | Priority | …`, of the values read back. Title, body file, an open milestone, one label that exists
(the REST API would create an unknown one), a Priority and every field named in the optional
`"requiredFields"` of `.github/workflow-project.json` (for example `["Size"]`) are required; `Status`
and `Priority` are not `--field` values. Everything is validated against the Project and repository before
the issue exists, so a missing or invalid value creates nothing (`ERROR - reason`, exit 2). The Status is Backlog, or the Project option given by `--status S` (e.g. `Ready`).
A failure after the issue exists names its URL and the failed step: finish by hand, never create it again.
- `new --from FILE`: create many issues at once. `FILE` is a JSON list (1 to 50 entries) of
`{ "title", "bodyFile", "milestone", "priority", "labels": [..], "fields": { "Size": "XS" } }`: the values of
the flags above, `bodyFile` relative to the working directory, Status Backlog. Every entry is checked
before the first issue exists (an unknown key, label, milestone or option, or a missing required value creates
nothing and names the entry). The issues are created over REST, which costs no GraphQL points; their Project items
and fields are then written in blocks of 5 issues (aliased mutations: add, write, read back, 3 requests per block),
so the GraphQL cost is 1 request for the field definitions plus 3 per block: 4 for up to 5 issues, 10 for 13, 31 for 50
(instead of 9 per issue). When GitHub refuses a block with "Resource limits for this query exceeded", `new` halves it
and asks again, down to one issue. An issue that is still refused, or whose values do not read back, is listed with
the `board.mjs field ISSUE NAME VALUE …` command that finishes it; everything else is complete. The output is one
`NEW …` line per issue. A failure after the first issue exists names every issue that exists: finish those by hand and
create only the missing ones. The field definitions are also read once per run by a single `new`, which therefore needs 4 requests (before: 8 to 9).
