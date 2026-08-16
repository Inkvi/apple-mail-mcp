/**
 * Live write tests. These execute real mutations against real Mail, so they
 * are off unless you opt in:
 *
 *   APPLE_MAIL_LIVE=1 APPLE_MAIL_LIVE_ACCOUNT="you@example.com" bun test live
 *
 * Every message these tests touch is one they created themselves, tagged
 * with a unique marker in the subject. `oursOnly` re-checks that marker
 * immediately before every mutation, so a bug in the test cannot reach real
 * mail: the worst failure is that it mutates nothing.
 *
 * The run creates a scratch mailbox, which on IMAP is a real server-side
 * folder visible in the web UI. Removing it again is attempted but not
 * guaranteed: Mail refuses to delete a Gmail folder over AppleScript with
 * error -10000 even once it is empty, verified live 2026-08-16. Delete the
 * folder by hand if you mind it staying.
 *
 * Deleted messages are left in Trash. That is what delete_messages does, so
 * the suite treats a copy in Trash as success rather than as residue.
 *
 * These tests are the reason four defects in the write path are fixed rather
 * than shipped: the script-text tests in mutations.test.ts passed throughout
 * while every write tool was a silent no-op.
 */
import { test, expect, describe } from "bun:test";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";
import { runAppleScript } from "../src/mail/applescript";
import {
  createDraft,
  setFlagged,
  markRead,
  moveMessages,
  deleteMessages,
  updateDraft,
  deleteDraft,
} from "../src/mail/mutations";
import type { MessageRow } from "../src/types";

const LIVE = process.env.APPLE_MAIL_LIVE === "1";
const ACCOUNT = process.env.APPLE_MAIL_LIVE_ACCOUNT ?? "";
const SCRATCH = "MCP-Live-Test";
const MARKER = `mcp-live-${Date.now().toString(36)}-${process.pid}`;

const root = findStoreRoot();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh connection per read, so nothing can be served from a stale snapshot. */
function read<T>(fn: (s: EnvelopeStore) => T): T {
  const s = new EnvelopeStore(root!);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

/** Every row carrying this run's marker, across all mailboxes. */
const ours = (): MessageRow[] => read((s) => s.searchMessages({ subject: MARKER, limit: 50 }));

/**
 * The safety interlock. Returns the ids to mutate, having confirmed every one
 * of them still carries this run's marker. Gmail gives one logical draft
 * several rows (Drafts plus All Mail), and a move assigns a new rowid, so
 * callers re-derive ids from the marker rather than remembering them.
 */
function oursOnly(): number[] {
  const rows = ours();
  for (const r of rows) {
    if (!r.subject?.includes(MARKER)) {
      throw new Error(`refusing to mutate ${r.rowid}: subject does not carry the marker`);
    }
  }
  return rows.map((r) => r.rowid);
}

/** Poll until the predicate holds, so tests never race Mail's indexing. */
async function until<T>(what: string, fn: () => T, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (Date.now() < deadline) {
    if (ok(last)) return last;
    await sleep(500);
    last = fn();
  }
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
}

const mailboxNames = (rows: MessageRow[]): string[] =>
  rows.map((r) => decodeURIComponent(r.mailboxUrl.replace(/^imap:\/\/[^/]+/, "")));

/** Ask Mail directly, so a passing test is never SQLite agreeing with itself. */
async function viaAppleScript(rowid: number, property: string): Promise<string> {
  const out = await runAppleScript(`
    tell application "Mail"
      repeat with acct in every account
        repeat with box in every mailbox of acct
          try
            repeat with m in (every message of box whose id is ${rowid})
              return (${property} of m) as text
            end repeat
          end try
        end repeat
      end repeat
      return "NOT-FOUND"
    end tell`);
  return out.trim();
}

/**
 * What Mail believes the scratch mailbox holds.
 *
 * The move is verified here rather than through `mailboxUrl`, because on
 * Gmail the two disagree: after moving a message into a label, AppleScript
 * reports it in that label while the Envelope Index still attributes it to
 * All Mail. Verified live 2026-08-16. SQLite is not wrong so much as it
 * records Gmail's storage rather than Gmail's labels, and a move test that
 * asserted on the URL would fail against working code.
 */
async function scratchSubjects(): Promise<string> {
  return (
    await runAppleScript(`
    tell application "Mail"
      set b to (first mailbox of (first account whose name is "${ACCOUNT}") whose name is "${SCRATCH}")
      set out to ""
      repeat with m in messages of b
        set out to out & (subject of m) & linefeed
      end repeat
      return out
    end tell`)
  ).trim();
}

const newDraft = (suffix: string) =>
  createDraft({
    to: ["nobody@example.invalid"],
    subject: `${MARKER} ${suffix}`,
    body: `Created by the live test suite. Safe to delete. ${MARKER}`,
  });

describe.skipIf(!LIVE)("live write path", () => {
  // Setup is a test rather than beforeAll for the same reason cleanup is:
  // Bun caps lifecycle hooks at five seconds, and creating an IMAP folder
  // routinely takes longer. Tests run in order, so this runs first.
  test("scratch mailbox is available", async () => {
    if (!root) throw new Error("no Apple Mail store found");
    if (!ACCOUNT) throw new Error("set APPLE_MAIL_LIVE_ACCOUNT to the account name to test against");
    // Tolerated failure: the mailbox may already exist from an earlier run.
    await runAppleScript(`
      tell application "Mail"
        try
          tell (first account whose name is "${ACCOUNT}")
            make new mailbox with properties {name:"${SCRATCH}"}
          end tell
        end try
      end tell`);
    expect(await scratchSubjects()).toBeDefined();
  }, 120_000);

  // Cleanup is a test, not afterAll, because Bun caps lifecycle hooks at five
  // seconds and each AppleScript sweep alone takes several. Tests run in
  // order, so this runs last whether or not the ones above passed.
  const cleanup = async () => {
    for (let i = 0; i < 4; i++) {
      const ids = oursOnly();
      if (!ids.length) return;
      try {
        await deleteMessages(ids);
      } catch {
        // A copy Mail will not delete must not strand the rest.
      }
      await sleep(2000);
    }
  };

  test("create_draft produces a message the read path can find", async () => {
    await newDraft("create");
    const rows = await until("the draft to be indexed", ours, (r) => r.length > 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.subject).toContain(MARKER);
  }, 60_000);

  test("flagging actually changes the flag, in SQLite and in Mail", async () => {
    const ids = oursOnly();
    expect(ids.length).toBeGreaterThan(0);

    const touched = await setFlagged(ids, true);
    expect(touched).toBeGreaterThan(0);

    const flagged = await until("flagged=true in SQLite", ours, (r) => r.length > 0 && r.every((m) => m.flagged));
    expect(flagged.every((m) => m.flagged)).toBe(true);
    expect(await viaAppleScript(flagged[0]!.rowid, "flagged status")).toBe("true");

    expect(await setFlagged(oursOnly(), false)).toBeGreaterThan(0);
    const unflagged = await until("flagged=false in SQLite", ours, (r) => r.length > 0 && r.every((m) => !m.flagged));
    expect(unflagged.every((m) => m.flagged)).toBe(false);
  }, 120_000);

  test("marking unread and read actually changes read state", async () => {
    const ids = oursOnly();
    expect(ids.length).toBeGreaterThan(0);

    expect(await markRead(ids, false)).toBeGreaterThan(0);
    const unread = await until("read=false in SQLite", ours, (r) => r.length > 0 && r.every((m) => !m.read));
    expect(unread.every((m) => m.read)).toBe(false);
    expect(await viaAppleScript(unread[0]!.rowid, "read status")).toBe("false");

    expect(await markRead(oursOnly(), true)).toBeGreaterThan(0);
    const readRows = await until("read=true in SQLite", ours, (r) => r.length > 0 && r.every((m) => m.read));
    expect(readRows.every((m) => m.read)).toBe(true);
  }, 120_000);

  test("moving relocates the message into the scratch mailbox", async () => {
    const ids = oursOnly();
    expect(ids.length).toBeGreaterThan(0);

    expect(await moveMessages(ids, SCRATCH, ACCOUNT)).toBeGreaterThan(0);

    // A move assigns a new rowid, so this asserts on the marker reaching the
    // mailbox, never on the ids that went in.
    let landed = "";
    for (let i = 0; i < 20 && !landed.includes(MARKER); i++) {
      if (i) await sleep(1000);
      landed = await scratchSubjects();
    }
    expect(landed).toContain(MARKER);
  }, 180_000);

  test("deleting moves to Trash rather than erasing", async () => {
    const ids = oursOnly();
    expect(ids.length).toBeGreaterThan(0);

    expect(await deleteMessages(ids)).toBeGreaterThan(0);

    const after = await until(
      "a copy to reach Trash",
      ours,
      (r) => mailboxNames(r).some((n) => /trash|deleted|корзина/i.test(n)),
      60_000,
    );
    // The mail still exists; it moved. This is the contract delete_messages
    // advertises, and the reason the tool never erases.
    expect(after.length).toBeGreaterThan(0);
    expect(mailboxNames(after).some((n) => /trash|deleted|корзина/i.test(n))).toBe(true);
    // Deliberately not asserted: that the message left the label it was in.
    // On Gmail a label is not a location, and Mail keeps listing the deleted
    // message under its label until the account resyncs. Observed live
    // 2026-08-16, with the Trash copy already present. Asserting it here
    // would test Gmail's propagation delay rather than delete_messages.
  }, 180_000);

  test("a draft can be created, updated, and deleted", async () => {
    await newDraft("lifecycle");
    const created = await until(
      "the lifecycle draft to be indexed",
      () => ours().filter((r) => r.subject?.includes("lifecycle")),
      (r) => r.length > 0,
    );
    const draftId = created[0]!.rowid;

    // Updating is delete-and-recreate, so the replacement gets a new id.
    const updatedCount = await updateDraft(draftId, {
      to: ["nobody@example.invalid"],
      subject: `${MARKER} lifecycle updated`,
      body: "updated body",
    });
    expect(updatedCount).toBeGreaterThan(0);

    const updated = await until(
      "the updated draft to be indexed",
      () => ours().filter((r) => r.subject?.includes("lifecycle updated")),
      (r) => r.length > 0,
    );
    expect(updated[0]!.subject).toContain("lifecycle updated");

    expect(await deleteDraft(updated[0]!.rowid)).toBeGreaterThan(0);
  }, 180_000);

  test("cleanup leaves no messages outside Trash", async () => {
    await cleanup();
    await runAppleScript(`
      tell application "Mail"
        try
          delete (first mailbox of (first account whose name is "${ACCOUNT}") whose name is "${SCRATCH}")
        end try
      end tell`);

    // Trash is where delete_messages is supposed to leave things, so a copy
    // sitting there is success, not residue. Anything outside Trash is not.
    const stragglers = mailboxNames(ours()).filter((n) => !/trash|deleted|корзина/i.test(n));
    expect(stragglers).toEqual([]);
  }, 300_000);
});
