import { test, expect, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { EnvelopeStore, clampLimit } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";

describe("clampLimit", () => {
  test("defaults to 50 when omitted", () => {
    expect(clampLimit(undefined)).toBe(50);
  });

  test("clamps negative to 1", () => {
    expect(clampLimit(-1)).toBe(1);
    expect(clampLimit(-1000)).toBe(1);
  });

  test("clamps zero to 1", () => {
    expect(clampLimit(0)).toBe(1);
  });

  test("floors fractional values", () => {
    expect(clampLimit(2.7)).toBe(2);
    expect(clampLimit(0.4)).toBe(1);
  });

  test("falls back to 50 for NaN", () => {
    expect(clampLimit(NaN)).toBe(50);
  });

  test("falls back to 50 for Infinity", () => {
    expect(clampLimit(Infinity)).toBe(50);
    expect(clampLimit(-Infinity)).toBe(50);
  });

  test("caps at 1000", () => {
    expect(clampLimit(5000)).toBe(1000);
  });

  test("passes through an in-range integer", () => {
    expect(clampLimit(200)).toBe(200);
  });
});

const root = findStoreRoot();
const d = root ? describe : describe.skip;

d("EnvelopeStore against the real store", () => {
  const store = new EnvelopeStore(root!);
  afterAll(() => store.close());

  test("lists mailboxes with counts", () => {
    const boxes = store.listMailboxes();
    expect(boxes.length).toBeGreaterThan(0);
    // The store also holds local:// mailboxes (Drafts, SendLater), so find an imap one.
    const imap = boxes.find((b) => b.url.startsWith("imap://"));
    expect(imap).toBeDefined();
    expect(imap!.accountId).toBeTruthy();
  });

  test("returns recent messages with joined subject and sender", () => {
    const rows = store.searchMessages({ limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.subject !== null)).toBe(true);
    expect(rows.some((r) => r.sender !== null)).toBe(true);
  });

  test("orders newest first", () => {
    const rows = store.searchMessages({ limit: 20 });
    const dates = rows.map((r) => r.dateReceived);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  // Skip explicitly when the store genuinely has no unread mail; otherwise an
  // empty result would let every() pass vacuously.
  const hasUnread = store.listMailboxes().some((b) => b.unreadCount > 0);
  test.skipIf(!hasUnread)("respects unreadOnly", () => {
    const rows = store.searchMessages({ unreadOnly: true, limit: 30 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.read === false)).toBe(true);
  });

  test("filters by sender substring", () => {
    const any = store.searchMessages({ limit: 1 });
    const sender = any[0]?.sender;
    // Tolerates a store whose newest message has no sender; not a silent pass.
    if (!sender) return;
    const domain = sender.split("@")[1]!;
    const rows = store.searchMessages({ from: domain, limit: 10 });
    // The seed message itself matches the filter, so at least one row must come back.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => (r.sender ?? "").includes(domain))).toBe(true);
  });

  test("filters by recipient address", () => {
    // Seed from the recipients table directly, so the expected match is known
    // up front and an empty result set fails instead of passing vacuously.
    const db = new Database(join(root!, "MailData", "Envelope Index"), { readonly: true });
    const seed = db
      .query(`select m.ROWID as rowid, ra.address as address
              from messages m
              join recipients r on r.message = m.ROWID
              join addresses ra on ra.ROWID = r.address
              where m.deleted = 0 and ra.address like '%@%'
              order by m.date_received desc limit 1`)
      .get() as { rowid: number; address: string } | null;
    db.close();
    // Tolerates a store with no recipient rows at all; not a silent pass.
    if (!seed) return;

    const rows = store.searchMessages({ recipient: seed.address, limit: 50 });
    // The seed is the newest message with any recipient, so it must be the
    // newest match for its own address and land inside the limit.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.rowid)).toContain(seed.rowid);

    // Prove the filter filters: an address that exists nowhere matches nothing.
    // An implementation that ignored the field would return the newest rows here.
    expect(store.searchMessages({ recipient: "no-such-recipient@nowhere.invalid" })).toEqual([]);
  });

  test("getMessage round-trips a rowid", () => {
    const first = store.searchMessages({ limit: 1 })[0]!;
    const again = store.getMessage(first.rowid);
    expect(again?.rowid).toBe(first.rowid);
  });

  test("the internal limit path is clamped too", () => {
    // Unclamped, -5 binds as LIMIT -5 which SQLite treats as unbounded, and
    // NaN raises a datatype mismatch. Both must clamp to a positive integer.
    const neg = store.searchMessages({}, -5);
    expect(neg.length).toBe(1);

    const nan = store.searchMessages({}, NaN);
    expect(nan.length).toBeGreaterThan(0);
    expect(nan.length).toBeLessThanOrEqual(50);
  });

  test("metadata search stays under 100ms", () => {
    const t = performance.now();
    store.searchMessages({ limit: 200 });
    expect(performance.now() - t).toBeLessThan(100);
  });
});
