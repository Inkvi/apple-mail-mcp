# Apple Mail MCP: build report

**Date:** 2026-08-15
**Status:** complete and merged to `main`, 29 commits, 95 tests passing
**Machine:** Mac mini (Apple M4 Pro, 64 GB), macOS 26.6.1 (build 25G76), Bun 1.3.14
**Store under test:** real Apple Mail V10 store, 103,429 messages, 416 MB Envelope Index

## What was built

An MCP server that reads Apple Mail's local store directly and mutates mail
through Mail.app. Ten tools, 1,683 lines of source, no send capability.

| Read (SQLite + `.emlx`) | Write (AppleScript) |
|---|---|
| `list_mailboxes` | `update_messages` |
| `search_messages` | `delete_messages` |
| `get_message` | `create_draft` |
| `get_thread` | `update_draft` |
| `get_attachment` | `delete_draft` |

## Why it exists

Four Apple Mail MCP servers already existed. None occupied this ground.

- **imdinu/apple-mail-mcp** reads the Envelope Index with FTS5. Fast, but
  read-only. It cannot organize mail.
- **sweetrb/apple-mail-mcp**, **patrickfreyer/apple-mail-mcp**, and
  **s-morgan-jeffries/apple-mail-fast-mcp** all drive AppleScript for
  everything, including list and search. That works on small mailboxes and
  times out on large ones.

The gap was fast local reads *plus* the ability to act on mail. This project
fills it by splitting the two paths: SQLite and `.emlx` for everything read,
AppleScript for everything written, one dispatcher in front, and a coherence
overlay to hide the gap between a write returning and the database showing it.

An early claim of mine that this ground was "unoccupied" was wrong, and worth
recording as such: imdinu already ships the SQLite read path, and
s-morgan-jeffries had spiked it and given it a GO. The real contribution is
narrower than "nobody did this", and the narrower claim is the true one.

## Three findings that changed the design

These were verified against the live store, not assumed. Each one contradicts
something in the existing projects or their published notes.

### 1. `.emlx` paths are computable, not searchable

The shard directory for a message is `reverse(digits(ROWID / 1000))` joined by
`/`. Verified against all 103,472 `.emlx` files in the store with zero
mismatches, and the test re-runs that check on every suite run.

This matters because the s-morgan-jeffries spike named locating body files as
the blocker and concluded "don't ship body fetch via rglob", having measured a
filesystem walk at roughly 1.9 seconds. It is arithmetic. Resolution costs
0.14 ms per message. Removing that blocker is what made the hybrid viable at
all.

### 2. `immutable=1` is a correctness bug, not an optimization

Opening the Envelope Index with `immutable=1` skips the write-ahead log. In
testing it reported 103,272 messages against a true 103,273, silently missing
a message that had just arrived. Any reader of this database must use
`mode=ro` / `{readonly: true}`. This is a hard global constraint in the spec,
and I had to correct my own early probes to honor it.

### 3. AppleScript message ids are SQLite ROWIDs

The published s-morgan-jeffries spike states that AppleScript's
`id of message` maps to `messages.message_id`. On macOS 26.6 it maps to
`messages.ROWID`. Verified directly.

This is why the project carries one id type where sweetrb and s-morgan-jeffries
both built dual-id schemes to bridge what they believed were two id spaces.
`test/parity.test.ts` guards the equivalence so a future macOS change surfaces
as a test failure rather than as silent mis-targeted writes.

## Measured performance

Neither prior project measured write visibility. That number sets the
coherence overlay's TTL, so it had to be measured rather than guessed.

| Operation | Result |
|---|---|
| 200 recent messages, joined on subject/sender/mailbox | 3.6 ms |
| `ROWID` to verified file path | 0.14 ms per message |
| Path resolution, 200 messages | 27.9 ms, 200/200 hit rate |
| AppleScript round trip | 180 to 200 ms |
| Write visible in SQLite after that round trip returns | 0 to 1 ms |

The write-visibility run also tested whether a long-lived readonly connection
goes stale, since the server keeps one connection for its lifetime. Across
four mutation windows it saw every change on its first poll, identical to a
freshly opened connection. Full method and caveats are in
`docs/measurements/wal-lag.md`.

The overlay TTL is 2000 ms. The brief's formula (4x observed max) would have
given 4 ms, which is a multiple of measurement noise rather than of real lag.
Choosing a sane floor over a formula is documented in the measurement file.

## Design decisions worth defending

**No send capability.** The mutation surface is organize plus drafts. The
server can compose a draft and leave it in Mail for a human to send. It cannot
put mail on the wire. This is a deliberate ceiling on blast radius, not an
unfinished feature.

**Body search narrows first, then scans.** There is no FTS5 index over
bodies. Metadata filters run in SQLite, and only the surviving candidates get
their `.emlx` files read. Above a cap of 5,000 candidates the server refuses
and says so rather than silently covering a subset. Mail's own full-text index
lives in a separate protected store and is not available.

**Degraded start beats hard exit.** If the store probe fails (a future macOS
format change, or missing Full Disk Access), the server still starts. Read
tools return an error naming the problem; write tools keep working, because
they route through Mail.app and do not touch the store.

## Testing

97 offline tests plus an 8-test live suite, clean `tsc --noEmit`. Fixtures are
synthetic. A runtime test reads 200 real messages from the live store and
commits nothing from them.

The live suite (`test/live.test.ts`, off unless `APPLE_MAIL_LIVE=1`) executes
real mutations against real Mail. Every message it touches is one it created,
tagged with a unique marker it re-checks immediately before each mutation, so
a bug in the test mutates nothing rather than something real. Each change is
verified twice, in SQLite and by asking Mail, so a pass is never the store
agreeing with itself.

Two smaller notes from the review pass: several tests initially could pass
vacuously, because `Array.every()` returns true on an empty array, and
non-vacuity guards were added; and iCloud proved unreachable via AppleScript
on this machine, so the parity test skips unreachable accounts rather than
failing on them.

## What the live tests found

Writing them was not a formality. **Every write tool was a silent no-op**, and
the entire offline suite passed the whole time.

1. **`whose id is in {1, 2}` matches nothing.** Mail accepts the syntax
   without error and returns zero messages. This predicate was shared by
   flag, read, move, and delete, so all four did nothing and reported zero
   touched. Fixed with an `or` chain: `id is 1 or id is 2`.
2. **Collecting message references, then mutating them, fails with -1728.**
   A collected reference is a positional specifier that Mail re-resolves on
   use, and any mailbox change in between invalidates it. Fixed by mutating
   inside the loop that finds the message.
3. **Walking hits forwards while deleting fails with -10000.** The mutation
   renumbers the collection under the loop. Fixed by walking backwards.
4. **`set deleted status of m to true` fails with -609 on Gmail**, for
   ordinary messages as well as drafts. The -609 error was already known for
   drafts; it turned out not to be draft-specific at all. `delete` is the
   only verb that works for both, and it still moves to Trash rather than
   erasing, which was verified.

The offline suite passed before and after every one of these fixes, including
when the predicate changed from `is in` to an `or` chain. That is the
strongest available argument that asserting on generated script text proves
nothing about whether the script works.

Three further findings are behaviour rather than defects, and are documented
in the README: mailbox names differ between the read and write paths; Gmail
labels are not locations, so SQLite and AppleScript disagree about where a
moved message lives; and a move assigns the message a new ROWID, so a
caller's id goes stale the moment it succeeds.

## Defects caught before shipping

The plan was reviewed against its own text before execution, and each task's
diff was reviewed after. Five defects were caught that would have shipped:

1. `Math.min(limit ?? 50, 1000)` let a negative limit through, and SQLite
   treats `LIMIT -1` as unbounded. Replaced with a total `clampLimit`.
2. Body search computed its candidate pool with the display limit, so a
   search covered 50 messages and reported the result as complete.
3. `child.killed` is true for *any* exited process in Bun 1.3.14, including a
   clean `exit 0`. The timeout check read it before the exit code, so every
   AppleScript call would have thrown "timed out". Replaced with an explicit
   timer flag.
4. A delete test asserted `toContain("trash")`, which was satisfied by an
   AppleScript comment rather than by any behavior.
5. The spec specified ten tools and the implementation registered eight;
   `update_draft` and `delete_draft` were never wired up.

## Open items

1. **Only one account type has been exercised live.** The live suite has run
   against Gmail IMAP. POP, Exchange, and local On My Mac mailboxes are
   untested, and Gmail was the account that produced every quirk found so
   far, so the others will have their own.
2. **A move invalidates the caller's ROWID and the coherence overlay keys on
   ROWID.** After a successful move the id the caller holds no longer names
   the message, so any overlay entry recorded against it describes a row that
   is gone. Nothing observed has gone wrong because of this yet, but the
   overlay's premise and the move's behaviour do not agree.
3. **`update_messages` cannot target system mailboxes.** Mail does not expose
   Trash, Sent, Drafts, or Junk as `mailbox "<name>" of account`, so a move to
   any of them fails. "Move this to Trash" is a reasonable request the tool
   cannot serve, though `delete_messages` covers the common case.
4. **Heavier mutations are unmeasured.** Write visibility was measured on a
   flag toggle against an idle Mail.app. Moves and deletes on a busy Mail may
   commit later. The 2000 ms TTL has room, but the data does not cover them.

## Installation note

macOS grants Full Disk Access per *responsible process*, not per binary. The
grant belongs to whatever launches the server: Claude Desktop for a Desktop
config, the terminal app for the CLI. Granting it to the `bun` binary does
nothing. The README originally said otherwise, and was corrected after
checking the TCC database: `bun` holds no grant, yet reads succeed, because
the grant flows down from the launching app.

Claude Desktop also launches servers with a minimal `PATH` that excludes
Homebrew, so the config needs the absolute path to `bun`.
