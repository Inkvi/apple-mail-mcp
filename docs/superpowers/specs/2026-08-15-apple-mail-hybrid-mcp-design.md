# Apple Mail Hybrid MCP Server: Design

**Date:** 2026-08-15
**Status:** Approved design, not yet implemented
**Author:** brainstormed with Claude, decisions by the repo owner

## Summary

An MCP server for Apple Mail that reads from Mail's own on-disk store (SQLite plus
`.emlx` files) and writes through Mail.app via AppleScript.

Reads are roughly three orders of magnitude faster than driving AppleScript, because
they never enter Mail.app at all. Writes stay on AppleScript so Mail remains the single
owner of its own state and nothing can corrupt the store.

The gap this fills: existing servers pick one side. Three of them (sweetrb,
patrickfreyer, s-morgan-jeffries) drive everything through AppleScript and are slow on
large mailboxes. One (imdinu) reads the local store and is fast, but is read-only. None
combines fast local reads with the ability to organize mail.

## Context and prior art

Four existing Apple Mail MCP servers were reviewed before starting.

| Project | Language | Read path | Write path |
|---|---|---|---|
| sweetrb/apple-mail-mcp | TypeScript | AppleScript, optional IMAP | AppleScript / SMTP |
| patrickfreyer/apple-mail-mcp | Python | AppleScript only | AppleScript |
| s-morgan-jeffries/apple-mail-fast-mcp | Python | AppleScript, optional IMAP | AppleScript / IMAP |
| imdinu/apple-mail-mcp | Python | Local store, FTS5 body index | None, read-only |

Two findings from that review shape this design.

**The AppleScript read path genuinely fails at scale.** s-morgan-jeffries ran a spike
(`docs/research/local-db-read-path-spike.md`, 2026-06-15) benchmarking a 32,623-message
Gmail INBOX. A `subject_contains` search took 136,993 ms through AppleScript, past their
own 60-second timeout, meaning the query does not merely run slowly, it fails. The same
query against the local store took 19.7 ms. Their recommendation was GO.

**The problem that stopped them is solved.** Their spike concluded that locating a body
file by walking the account subtree cost about 1.9 seconds across 60,000 files, and
warned "don't ship body fetch via rglob", leaving `ROWID` to path resolution as an open
problem to be handled by a watched index. That index is unnecessary. The path is
computable in constant time (see Verified facts below).

## Goals

- Metadata search and message reads that complete in single-digit to low tens of
  milliseconds on a 100k-message store.
- Full inbox triage: mark read, flag, move, delete to Trash.
- Compose replies and forwards as Mail drafts for human review.
- Correct behavior when the schema changes, degrading to a clear error rather than
  returning wrong results.

## Non-goals

- **Sending mail.** Drafts land in Mail's Drafts folder. The human presses send. No
  `send_now`, not behind a flag.
- **A body-text index.** No FTS5, no sync job, no filesystem watcher. Body search is
  metadata-narrowed then scanned (see Read path).
- **IMAP or SMTP.** No network, no credentials, no Keychain. Everything is local.
- **Server-authoritative freshness.** The store is as fresh as Mail's last sync. This is
  identical to what the AppleScript-based servers give you, since they read the same
  local state.
- **Windows or Linux.** macOS only, by construction.

## Verified facts

Everything in this section was measured against the live store on this machine on
2026-08-15 (103,273 messages, 416 MB Envelope Index, macOS 25.6.0, store version V10).
These are the load-bearing assumptions and each one has evidence.

### The database must be opened `mode=ro`, never `immutable=1`

The Envelope Index runs in WAL mode with Mail.app as sole writer. Opening with
`immutable=1` skips the WAL and silently returns stale data.

```
immutable=1  ->  103,272 messages, max ROWID 209951
mode=ro      ->  103,273 messages, max ROWID 209952
```

A message that had just arrived was invisible to the immutable read. This is a
correctness bug, not a performance note. `mode=ro` is mandatory.

### `.emlx` paths are computable in constant time

The filename stem is `messages.ROWID`, and the shard directories are the digits of
`ROWID / 1000` reversed.

```
shard(rowid) = rowid >= 1000 ? reverse(digits(rowid / 1000)).join("/") : ""

  ROWID 159566  ->  Data/9/5/1/Messages/159566.emlx
  ROWID 204121  ->  Data/4/0/2/Messages/204121.emlx
  ROWID    133  ->  Data/Messages/133.emlx
```

Full path shape:

```
~/Library/Mail/V10/<account-uuid>/<Seg>.mbox[/<Seg>.mbox...]/<store-uuid>/Data/[<shard>/]Messages/<ROWID>.emlx
```

**Verified against all 103,315 `.emlx` files in the store: 103,315 matches, 0
mismatches.** No filesystem search is required to locate a body.

Messages not fully downloaded from the server are stored as `<ROWID>.partial.emlx`
instead. Both names must be tried.

### Relevant schema

`messages` is the spine. Text fields are integer foreign keys into lookup tables, so
every read is a join.

| Column | Meaning |
|---|---|
| `ROWID` | Identity; also the `.emlx` filename stem |
| `subject` | FK to `subjects.ROWID` |
| `sender` | FK to `addresses.ROWID` |
| `mailbox` | FK to `mailboxes.ROWID` |
| `date_received`, `date_sent` | Unix epoch seconds |
| `read`, `flagged`, `deleted`, `flag_color` | Integer flags |
| `conversation_id` | Thread grouping |
| `size` | Bytes |

Supporting tables:

- `subjects(ROWID, subject)`, `addresses(ROWID, address, comment)`
- `mailboxes(ROWID, url, total_count, unread_count, ...)` where `url` is
  `imap://<account-uuid>/<url-encoded path>`, for example
  `imap://11111111-.../%5BGmail%5D/All%20Mail`
- `recipients(message, address, type, position)` for To/Cc/Bcc
- `attachments(message, attachment_id, name)`
- `message_global_data(message_id, message_id_header, ...)` carries the RFC 5322
  `Message-ID`. Populated on 102,996 of 103,154 rows, so it is reliable but nullable.

### There is no body text in the database

`searchable_messages` looks promising but is indexing bookkeeping
(`message_body_indexed`, `reindex_type`, `transaction_id`), not content. Mail's actual
full-text index lives in a separate protected store. Body text is only available by
reading `.emlx` files.

### Measured performance

| Operation | Time |
|---|---|
| 200 recent messages with subject/sender/mailbox joins | 3.6 ms |
| `ROWID` to verified file path | 0.14 ms per message |
| Path resolution for 200 messages | 27.9 ms, 200/200 hit rate |

### MIME complexity in the real store

Sampled across 3,000 random messages:

- 77% multipart
- 23% contain RFC 2047 encoded headers (`=?UTF-8?B?...?=`)
- Charsets: utf-8 dominant, then iso-8859-1, windows-1252, us-ascii. No significant
  legacy tail (no koi8-r, iso-2022-jp, or gb2312) despite non-Latin mail being present.
- Transfer encodings: quoted-printable dominant, then 7bit, base64, 8bit

## Architecture

Two independent paths behind one dispatcher. They share no state except the coherence
overlay.

```
                       MCP client
                            |
                       server.ts
                     (tool definitions)
                            |
                     dispatcher.ts
                    /               \
              read path           write path
                  |                    |
        +---------+--------+     mutations.ts
        |                  |           |
   envelope.ts         emlx.ts   applescript.ts
   (bun:sqlite,      (unwrap +          |
    mode=ro)         mailparser)   osascript -> Mail.app
        |                  |
    paths.ts (ROWID -> file path)
                    \      /
                  overlay.ts
            (recent writes, TTL)
```

### Modules

Each is independently testable and small enough to hold in context.

**`store/paths.ts`** Pure functions. `shardFor(rowid)`, `mailboxDir(url)` (parses the
`imap://` URL, URL-decodes segments, appends `.mbox` per segment), and
`emlxPath(rowid, mailboxUrl)`. No I/O beyond an existence check. Zero dependencies,
exhaustively testable against the real store.

**`store/envelope.ts`** Owns the only SQLite connection. Opens `mode=ro`. Exposes
`searchMessages(filter)`, `getMessage(rowid)`, `listMailboxes()`, `getThread(convId)`.
Returns a normalized `MessageRow`. All joins live here, nothing else writes SQL.

**`store/emlx.ts`** Reads a `.emlx`, strips the wrapper (leading byte count line,
trailing plist), hands the RFC 822 payload to `mailparser`. Returns text body, HTML
body, headers, attachment metadata. **Constraint: never parse headers by hand.** See
Failure handling for why this is a hard rule.

**`store/probe.ts`** Runs once at startup. Locates the `V*` directory, confirms every
table and column this server reads actually exists, and confirms the shard rule holds
for a few sampled messages. On any mismatch the server starts in a degraded state where
read tools return a clear "unsupported Mail store version" error rather than silently
wrong data.

**`mail/applescript.ts`** Wraps `osascript -` over stdin via `Bun.spawn`. Owns timeouts,
child process cleanup (patrickfreyer hit orphaned `osascript` children, worth copying
their fix), and escaping. Escaping is the injection surface, so it gets its own tests.

**`mail/mutations.ts`** One function per mutation, each generating AppleScript and
delegating to the bridge. Locates messages by Mail's own numeric id.

**`coherence/overlay.ts`** In-memory map of `rowid` to pending expected state, with a
TTL. Written on every successful mutation, consulted on every read, entry dropped once
SQLite agrees or the TTL expires.

**`dispatcher.ts`** The only module that knows both paths exist. Routes each tool call to
the read path or the write path, applies the overlay to outbound rows, records overlay
entries after successful mutations, and enforces the body-scan candidate threshold.
Keeping this in one place is what lets `server.ts` stay declarative and lets the two
paths stay unaware of each other.

**`server.ts`** Tool definitions and schemas only. No logic.

## Read path

A search runs in two stages and the second stage is usually skipped.

1. **Narrow in SQLite.** Sender, recipient, subject, mailbox, date range, read/flagged
   state, attachment presence. This is a single indexed join over 103k rows and costs
   single-digit milliseconds.
2. **Scan bodies only if `body` was supplied.** Resolve each surviving candidate to its
   file in 0.14 ms, read, parse, filter.

The design bet is that real queries are anchored. "From Stripe last month mentioning
refund" narrows to roughly 50 candidates before any file is touched, so the total is
about 34 ms.

**The known weakness, stated plainly:** an unanchored body-only search across the whole
store degrades to reading 103k files, on the order of 60 to 90 seconds. This is
accepted, not solved. Mitigation is honesty rather than machinery: when a `body` filter
would scan more than a threshold (default 5,000 candidates), the tool refuses and
returns the candidate count with a message asking for a narrowing filter. It must never
quietly scan for two minutes, and must never quietly truncate and imply full coverage.

If this refusal fires often in practice, that is the evidence that would justify
revisiting FTS5. Not before.

## Write path

Every mutation goes through AppleScript into Mail.app. Mail.app remains the sole writer
of its own store. The server never writes to the Envelope Index or to any `.emlx` file.

This is slower (roughly 1 to 10 seconds per operation) and that is the correct trade.
The alternative, writing to Mail's database directly, risks corrupting the store and
desynchronizing Mail's in-memory state.

Drafts are the only compose primitive. `create_draft` handles new, reply
(`reply_to`), and forward (`forward_of`). Mail.app forbids mutating a saved draft in
place, so `update_draft` is implemented as delete-and-recreate, re-seeding threading
headers from the original. This behavior is documented rather than hidden, since it
changes the draft's identity.

## Coherence model

Reads come from SQLite, writes go through Mail.app, so a write is not instantly visible
to a read. Mail.app updates the Envelope Index as part of the operation, so the lag is
expected to be short, but **the exact lag is unmeasured** and both prior investigations
left it unmeasured too.

Without handling, the failure is an agent loop: flag a message, re-read, see it
unflagged, flag it again.

**Design: read-repair overlay.** On a successful mutation, record
`rowid -> {read?, flagged?, mailbox?}` with a timestamp. Every read merges pending
entries over the SQLite row. An entry is dropped when SQLite reports the expected value
or when the TTL expires.

**Phase 0 measures the lag first**, on a throwaway message in a dedicated scratch
mailbox, never on real mail. That measurement sets the TTL. If the lag is reliably under
about 50 ms the overlay stays in place but almost never fires, which is a fine outcome:
it costs one map lookup per read and removes a whole class of agent misbehavior.

The overlay is deliberately in-memory and non-persistent. It is a smoothing layer over a
short window, not a cache, and it must never be the source of truth for anything.

## Tool surface

Ten tools. Read tools are cheap and safe. Write tools are explicit about blast radius.

### Read

| Tool | Purpose |
|---|---|
| `list_mailboxes` | Accounts and mailboxes with counts, straight from `mailboxes` |
| `search_messages` | Metadata filters plus optional narrowed `body` scan |
| `get_message` | Full message: headers, text and HTML body, attachment list |
| `get_thread` | Messages sharing a `conversation_id`, ordered |
| `get_attachment` | Attachment content, byte-capped |

### Write

| Tool | Purpose | Reversible |
|---|---|---|
| `update_messages` | Batch mark read/unread, flag/unflag, move | Yes |
| `delete_messages` | Move to Trash, never hard delete | Yes, from Trash |
| `create_draft` | New, reply, or forward. Saves to Drafts | Yes |
| `update_draft` | Delete and recreate, preserving threading | Yes |
| `delete_draft` | Move draft to Trash | Yes, from Trash |

Every write is reversible by design. `delete_messages` moves to Trash and the tool
description says so, so an agent cannot believe it is doing something more destructive
or less destructive than it is.

## Failure handling

**Schema drift is the top risk.** Apple bumps `V<n>` across major macOS releases and can
rename columns. The startup probe checks the store version and every column read. On
mismatch, read tools return a clear error naming the unsupported version. The server
does not fall back to AppleScript reads, because a silent 5,000x slowdown is worse than
a clear failure, and because write tools keep working regardless.

**Missing `.emlx` files.** Exchange and EWS accounts may not store bodies locally, and
`.partial.emlx` bodies are incomplete by definition. Both cases return metadata with an
explicit `bodyAvailable: false` rather than an empty body that reads as "no content".

**Never hand-roll MIME parsing.** This is a constraint with evidence behind it. A
twenty-line regex written during design produced roughly 15% garbage against this
store's real mail: it reported charsets like `3dutf-8` (quoted-printable `=3D` leaking
out of nested forwarded messages) and header values named `mime-version` and
`message-id` (the pattern running past an empty header value into the next header's
name). Given 77% multipart and 23% encoded headers, `mailparser` handles the payload and
hand-written parsing does not.

**AppleScript failures** surface as errors with the `osascript` stderr attached. No
silent retries. A timeout is reported as a timeout, since the mutation may well have
succeeded.

## Security and permissions

Two separate macOS permissions, and they should be described accurately to the user
because one of them is broad.

- **Automation** (Mail.app), for the write path. Prompted on first use.
- **Full Disk Access**, for the read path, granted to the runtime binary (`bun`), not to
  this project. This is a broad grant and the README must say so plainly rather than
  burying it in setup steps.

The read path is strictly read-only: `mode=ro`, and file reads only. The server never
writes to Mail's store. All mail content stays on the machine; there is no network code
in the project.

AppleScript escaping is the injection surface. Any user or model supplied string
reaching a generated script (mailbox names, search terms, draft bodies) is escaped in
one place in `applescript.ts` and that function has adversarial tests.

## Testing

**Path derivation** is the highest-value test, since the whole read path rests on it.
Property test `shardFor` against the live store: enumerate every `.emlx`, assert derived
path equals actual. This already passes at 103,315/103,315 and should run in CI on any
machine with a store.

**`.emlx` parsing** against committed fixtures covering the measured distribution:
multipart, RFC 2047 headers, quoted-printable, base64, each charset, and a
`.partial.emlx`.

**Parity** against AppleScript. For the same query, the SQLite path and the AppleScript
path must return the same messages with the same flags. This is what licenses the fast
path to front the slow one, and it is non-negotiable before shipping. Both prior
projects call this out.

**Mutations** run against a dedicated scratch mailbox created by the test setup, never
against real mail.

**Escaping** gets adversarial cases: quotes, backslashes, newlines, non-ASCII, and
strings shaped like AppleScript.

## Phasing

Each phase ends with something usable.

**Phase 0: measure.** WAL commit lag after an AppleScript mutation, on a scratch
mailbox. Output is the overlay TTL. Small, but it is the one number the coherence design
needs and nobody has it.

**Phase 1: read path.** `paths.ts`, `envelope.ts`, `emlx.ts`, `probe.ts`, and the five
read tools. Ends with a fast read-only server, and parity tests passing.

**Phase 2: write path.** `applescript.ts`, `mutations.ts`, `update_messages`,
`delete_messages`. Ends with full triage. This is the point where the project is
something that does not already exist.

**Phase 3: coherence.** The overlay, with the Phase 0 TTL.

**Phase 4: drafts.** `create_draft`, `update_draft`, `delete_draft`.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Schema changes in a future macOS | High | Startup probe, clear error, writes unaffected |
| Shard rule is store-specific | Medium | Verified 103,315/103,315 here, but on one machine only. Probe samples it at startup; fall back to a bounded directory scan for a single message rather than failing |
| Full Disk Access is a broad grant | Medium | Document prominently; it is the honest cost of the read path |
| Unanchored body search is slow | Medium | Refuse above a candidate threshold rather than hanging |
| WAL lag causes agent loops | Low | Overlay, sized by Phase 0 |
| Exchange accounts lack local bodies | Low | Explicit `bodyAvailable: false` |

## Open questions

1. **What is the actual WAL commit lag?** Phase 0. Sets the TTL.
2. **Does the shard rule hold on other machines and other macOS versions?** Verified
   exhaustively on one store. The startup probe covers this at runtime, but a second
   machine would raise confidence.
3. **Gmail's All Mail duplicates messages across labels.** Should search deduplicate by
   `message_id_header` by default? Leaning yes with an opt-out, but deferred until the
   read path exists and the duplication can be measured rather than guessed at.
