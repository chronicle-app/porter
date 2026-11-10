# Agent notes

Guidance for AI coding agents working in this repository.

## Attribution

Do not add AI attribution to anything committed. No `Co-Authored-By` lines
for AI tools in commit messages, no "Generated with" footers in pull request
descriptions, and no agent names in code comments or docs. Commits are
authored by the human running the tool.

## Project

Porter is a local blob store and RASL server for Chronicle. TypeScript, ESM,
Node.js 22.13+, one npm package with library exports and a `porter` bin.
Entry point is `bin/porter.js`, which loads the built `dist/src/cli.js`.

Run commands inside the nix dev shell (`nix develop` or direnv); bare `node`
outside it may be the wrong version. `menu` lists the shell's commands.

```sh
npm ci
npm run typecheck
npm test            # builds first
npm run build
```

## Conventions

- Porter is mostly a library. Document behavior where people meet it: TSDoc
  on every export (it ships in the `.d.ts` and shows in editors), the HTTP
  endpoints in the README, and each CLI command in `porter COMMAND --help`.
  Keep `README.md` short: what Porter is, a library example, the endpoints.
  Do not add a `docs/` directory.
- On-disk names (temp files, locks, the index, the token) use `porter-`.
- Blobs are named by DASL CIDs only: CIDv1, SHA-256, raw or DRISL codec.
  Use `@atcute/cid` for CIDs. Parse strings from outside with `parseCid`, so
  bad input becomes a `CidError` with a code and hint.
- `ByteStore` holds opaque bytes by key; `BlobStore` names them by CID and
  checks them. Backends implement `ByteStore`; never hash inside one.
- Blob files are created only by writing a temp file, fsyncing, and renaming
  it into place. They are never modified afterwards. Anything that replaces
  one must do so from a verified copy.
- S3 requests always sign `x-amz-content-sha256` with the real payload hash.
  aws4fetch sends `UNSIGNED-PAYLOAD` if the header is missing, which leaves
  the body unchecked.
- The HTTP server is read-only RASL on localhost. Writes go through the library.
- Test with synthetic bytes. Keep personal data and credentials out of
  fixtures and logs.
- Run the full test suite before committing. If a test fails only under
  parallel load, raise timeouts in `vitest.config.ts` rather than skipping it.
- Test the library through its API. Test what a CLI command did through
  `--json` and `--events`, never through the text it prints, which changes
  freely. For errors: the exit code, the
  error's `code`, and that its `hint` names the command it points at.
  Printed output is checked only for raw escape codes and color.

## Output

The library never prints. It returns results, throws errors with a `code`
and a `hint`, and reports progress as events the caller can render. This
section is about the CLI and `porter serve`'s logs.

Porter's CLI looks and reads like Chronicle and Vestry. Messages are Chronicle's
`@chronicle.app/logging` events: a `kind`, a `level`, a plain `message`, and
a `hint`. When the first real command lands, port Vestry's `src/output/` (the
blocks, and the pretty and plain sinks) rather than writing new styling. It's
the only place terminal text is styled. Don't write ANSI codes anywhere else.

- **Results go to stdout; everything else to stderr** as events: notices,
  warnings, errors, hints, and progress. Repeats roll up: three examples,
  then a count.
- **A result starts with a summary line**: status glyph, what happened, the
  time it took (`✓ Blob stored  in 12ms`), then its details as a card.
- **Rows of one kind are a table**: blobs, tiers, queue entries. A row per
  item under muted headings and a rule, so grep and awk can read it. A cell
  is one word: `-` for nothing, plain numbers (`1632`), dates as
  `2026-07-15`, and a time in a column of its own. A path or CID goes last
  and prints whole. Notes about rows, like what failed, go under the table.
- **Errors** read `✗ Error: <message>`, with what to do as a `↳` hint below.
  Errors carry a `code` and the hint, which show in `--json` errors too.
- **Color only carries meaning**: status (`success`, `danger`, `warning`),
  `strong`, `muted`, one `accent` for live elements, and cyan for something
  to type. Without color, a code span keeps its backticks.
- **One glyph set**: `✓ ✗ ! · → ↳ ━ ─ …`, braille spinner frames. No boxes,
  no `====` underlines, no emoji.
- **At a terminal**, notices and errors end with the time, right-aligned and
  muted, and progress is a live line redrawn in place. **In a pipe or file**,
  each line starts with the time, and a long command logs a line every 10
  seconds.
- **Paths** print from `~`. Paths, CIDs, and commands are never cut: a long
  one wraps whole. **Numbers** grouped (`1,240`), **sizes** in Finder's units
  (`4.2 MB`), **dates** local to the minute, **durations** as spoken (`40ms`,
  `4.2s`, `3m 07s`).
- **Text from blobs, the index, and remote responses goes through `clean`**,
  so control characters in it can't drive the terminal.

## Writing messages

Errors, hints, notices, and help are read by someone who is stuck. Write
them the way a person who knows the tool would say it out loud.

```
✗ Error: No remote configured
  ↳ Add one with:
      porter remote add r2 https://ACCOUNT.r2.cloudflarestorage.com/BUCKET
```

- **The error says what happened** in a few words, with no period and no
  advice: `Unknown command stat`, `Not a DASL CID: Qm3x…`.
- **The hint is one or two plain sentences**, ending in a period, with
  commands inline in backticks: "Run `porter scan` to rebuild the index."
  "Did you mean `porter status`?" A sentence that ends in a command puts it
  on a line of its own.
- **Commands are real and runnable as printed**: fill in the CID or path you
  have. Placeholders only for what the person alone knows (`PATH`, `BUCKET`).
- **Use plain verbs and contractions**: run, use, pass, pick, keep. Not
  "ensure", "retain", "proceed", "utilize", "is not supported by".
- **Don't describe the program** ("Porter will…", "it reads") or narrate
  ("Preparing the following…"). State the fact: "The local copy is kept."
- **Don't join phrases with `·` or `;`** in a message; write two sentences.

Read a message aloud before committing it. If it sounds like a form, a
manual, or a chatbot, rewrite it.
