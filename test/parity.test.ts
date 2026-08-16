import { test, expect, describe, afterAll } from "bun:test";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";
import { runAppleScript, escapeAppleScript } from "../src/mail/applescript";
import type { MailboxRow } from "../src/types";

/**
 * Parity gate between the SQLite read path and AppleScript. The fast path
 * is only allowed to front the slow one if both return the same messages
 * with the same flags. This also guards the id equivalence: AppleScript's
 * `id of message` is the SQLite ROWID, verified directly against this store,
 * even though a published spike claims it maps to messages.message_id.
 * Read-only throughout: every AppleScript here is a query, never a mutation.
 */

const root = findStoreRoot();
const d = root ? describe : describe.skip;

const store = root ? new EnvelopeStore(root) : null;

/**
 * Ask AppleScript how many messages a mailbox holds. Returns null when the
 * account or mailbox does not resolve. `MailboxRow.name` is the full path
 * form ("[Gmail]/Spam"), which Mail resolves directly; the leaf name alone
 * does not.
 */
async function probeMailbox(box: MailboxRow): Promise<number | null> {
  try {
    const out = await runAppleScript(`
      tell application "Mail"
        set acct to (first account whose id is "${escapeAppleScript(box.accountId)}")
        set theBox to mailbox "${escapeAppleScript(box.name)}" of acct
        return count of messages of theBox
      end tell`);
    const n = Number(out.trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Read id, read status, and flagged status for the newest n messages. */
async function viaAppleScript(box: MailboxRow, n: number) {
  const out = await runAppleScript(`
    tell application "Mail"
      set acct to (first account whose id is "${escapeAppleScript(box.accountId)}")
      set theBox to mailbox "${escapeAppleScript(box.name)}" of acct
      set collected to ""
      repeat with i from 1 to ${n}
        set m to message i of theBox
        set collected to collected & (id of m) & "|" & (read status of m) & "|" & (flagged status of m) & linefeed
      end repeat
      return collected
    end tell`);

  return out
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [id, read, flagged] = line.split("|");
      return { rowid: Number(id), read: read === "true", flagged: flagged === "true" };
    });
}

// Walk candidate mailboxes smallest-first until one is reachable via
// AppleScript. Some accounts are offline or disabled in Mail and report 0
// messages for every mailbox despite SQLite showing content; failing on
// those would make the test go red for environmental reasons and train
// people to ignore it, so unreachable candidates are skipped instead.
let target: MailboxRow | null = null;
let scriptCount = 0;
const skipped: string[] = [];

if (store) {
  const candidates = store
    .listMailboxes()
    .filter((b) => b.totalCount > 0 && b.totalCount < 500)
    .sort((a, b) => a.totalCount - b.totalCount)
    .filter((b) => store.searchMessages({ mailboxUrl: b.url, limit: 1 }).length > 0);

  for (const box of candidates) {
    const count = await probeMailbox(box);
    if (count === null) {
      skipped.push(`${box.accountId}/${box.name}: account or mailbox not resolvable via AppleScript`);
      continue;
    }
    if (count === 0) {
      skipped.push(`${box.accountId}/${box.name}: AppleScript reports 0 messages, account likely offline`);
      continue;
    }
    target = box;
    scriptCount = count;
    break;
  }
}

d("parity between the SQLite path and AppleScript", () => {
  afterAll(() => store?.close());

  const it = target
    ? test
    : test.skip;
  const name = target
    ? `AppleScript ids appear as ROWIDs in SQLite with matching flags (${target.name}, ${scriptCount} messages)`
    : `no AppleScript-reachable mailbox found, skipped candidates: ${skipped.join("; ") || "none"}`;

  it(name, async () => {
    const n = Math.min(10, scriptCount);
    const fromScript = await viaAppleScript(target!, n);

    // Guard against vacuity: an empty comparison proves nothing.
    expect(fromScript.length).toBeGreaterThan(0);

    for (const scripted of fromScript) {
      const row = store!.getMessage(scripted.rowid);

      // The id equivalence itself. If this fails, AppleScript ids are no
      // longer SQLite ROWIDs, which means every mutation in this project
      // silently targets the wrong messages. Stop and investigate before
      // trusting any write path.
      expect(
        row,
        `AppleScript id ${scripted.rowid} has no matching ROWID in SQLite. ` +
          `The id equivalence (AppleScript message id == SQLite ROWID) no longer holds, ` +
          `so every mutation in this project targets the wrong messages. ` +
          `Do not work around this; the write path is unsafe until it is understood.`,
      ).not.toBeNull();

      expect(row!.read, `read mismatch on ${scripted.rowid}`).toBe(scripted.read);
      expect(row!.flagged, `flagged mismatch on ${scripted.rowid}`).toBe(scripted.flagged);
    }
  }, 120_000);
});
