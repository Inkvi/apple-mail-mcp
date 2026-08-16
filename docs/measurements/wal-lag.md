# WAL commit lag after AppleScript mutations

How long after an AppleScript write does the change become visible when
reading Mail's Envelope Index SQLite database? This number sets the TTL for
the coherence overlay (Task 10). Neither prior open-source project in this
space measured it.

## Setup

- Date: 2026-08-15
- Machine: Mac mini, Apple M4 Pro, 64 GB
- macOS: 26.6.1 (build 25G76)
- Bun: 1.3.14, `bun:sqlite` with `{ readonly: true }` (never `immutable=1`)
- Script: `scripts/measure-wal-lag.ts`
- Target: one controller-selected marketing spam message, rowid 209947, in
  `[Gmail]/Spam` of account `44444444-5555-4000-8000-666666666666`. The only
  mutation was toggling its `flagged status` via Mail.app, five times, then
  restoring the original `flagged=false`.

Per iteration the script toggled the flag through `osascript`, then polled
two readers every 10ms until each observed the new value:

1. **long-lived**: one `EnvelopeStore` opened before the loop and kept open,
   matching the MCP server's real read path (one connection for its lifetime)
2. **fresh**: a new `EnvelopeStore` constructed on every poll

## Raw output

```
Target: rowid=209947 in [Gmail]/Spam of account 44444444-5555-4000-8000-666666666666
Original state: flagged=false read=false
Subject: You’re Paying for AI… Then Losing the Work

iteration 1: osascript 185ms, long-lived saw it after 1ms, fresh saw it after 1ms
iteration 2: osascript 181ms, long-lived saw it after 0ms, fresh saw it after 1ms
iteration 3: osascript 182ms, long-lived saw it after 0ms, fresh saw it after 1ms
iteration 4: osascript 182ms, long-lived saw it after 0ms, fresh saw it after 1ms
iteration 5: osascript 198ms, long-lived saw it after 0ms, fresh saw it after 1ms

Restore: original flagged=false
  AppleScript now reports flagged=false (OK)
  SQLite now reports flagged=false (OK)

long-lived lag (ms): 1, 0, 0, 0, 0
fresh lag (ms):      1, 1, 1, 1, 1
long-lived: median 0ms, max 1ms
fresh:      median 1ms, max 1ms
Suggested overlay TTL: 1000ms (4x observed max, sanity-check against a floor)
```

## Results

- **Lag is effectively zero.** By the time `osascript` returns (roughly
  180 to 200ms per call), the change is already committed to the WAL and
  visible to readers. Both readers observed every change on their very first
  poll; the 0 to 1ms values are just the cost of that first query.
- **The long-lived connection never went stale.** A long-lived `bun:sqlite`
  readonly connection observed every WAL commit made by Mail.app, on the
  first poll, in all five iterations, exactly like a freshly opened
  connection. Each query starts a new read transaction, so it picks up the
  latest WAL snapshot. The feared architectural defect (the server's single
  long-lived reader silently serving stale rows after Mail writes) does not
  exist. No difference between the two readers was observed.
- Restore verified: `flagged=false, read=false` in both AppleScript and
  SQLite after the run, matching the original state.

## Recommended overlay TTL: 2000ms

The brief's formula (4x observed max) gives 4ms, which is not a sane TTL: it
is a multiple of measurement noise, not of the real lag. What the data shows
is that visibility is bounded by the osascript round trip itself (about
200ms), after which the read path is immediately coherent.

Use a modest floor instead: **2000ms**. Reasoning:

- It is roughly 10x the full osascript round trip and about 2000x the
  observed post-return lag, so it comfortably covers everything measured.
- The measurement covered only a flag toggle on an idle Mail.app. Heavier
  mutations (moves, deletes) and a busy Mail.app were not measured and may
  commit later; 2 seconds absorbs plausible scheduling delays without
  making the overlay meaningfully sticky.
- A larger value buys nothing: the overlay only masks the window between
  issuing a write and SQLite reflecting it, and that window is measured in
  milliseconds here.

If Task 10 ever observes an overlay entry still disagreeing with SQLite at
expiry, that is a signal to re-measure with heavier mutations, not to bump
the constant blindly.
