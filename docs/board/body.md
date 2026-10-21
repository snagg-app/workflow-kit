# board.mjs body

`body ISSUE FILE BASE_FILE`: replace an issue body with `FILE` only if the current body
still equals `BASE_FILE` (the body your change is based on; line endings and trailing
whitespace are ignored; the text written is `FILE` with LF line endings and no trailing
whitespace, sent over stdin so the file name never matters), then read it back. A body that
changed meanwhile is refused with
a `-`/`+` diff (exit 1, nothing written); a read-back that differs from `FILE` reports
that another session overwrote it (exit 1, the write is not repeated); API and file
errors exit 2. See [Changing a body](../CONTRIBUTING.md#issues).
- `body-replace ISSUE --from FILE --to FILE`: replace exactly one occurrence of the text in
`FILE` after `--from` with the text after `--to` (plain text, no regular expressions, one
replacement per call; line endings and trailing whitespace are ignored like in `body`;
`--to` may be empty). The body read at that moment is the base, then the write and read-back
of `body` apply. No match or several matches are refused with the reason (exit 1, nothing
written; several matches are listed by line); an empty `--from` text, unreadable files and API
errors exit 2.
