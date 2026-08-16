import { test, expect, describe, afterAll } from "bun:test";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";

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

  test("respects unreadOnly", () => {
    const rows = store.searchMessages({ unreadOnly: true, limit: 30 });
    expect(rows.every((r) => r.read === false)).toBe(true);
  });

  test("filters by sender substring", () => {
    const any = store.searchMessages({ limit: 1 });
    const sender = any[0]?.sender;
    if (!sender) return;
    const domain = sender.split("@")[1]!;
    const rows = store.searchMessages({ from: domain, limit: 10 });
    expect(rows.every((r) => (r.sender ?? "").includes(domain))).toBe(true);
  });

  test("getMessage round-trips a rowid", () => {
    const first = store.searchMessages({ limit: 1 })[0]!;
    const again = store.getMessage(first.rowid);
    expect(again?.rowid).toBe(first.rowid);
  });

  test("metadata search stays under 100ms", () => {
    const t = performance.now();
    store.searchMessages({ limit: 200 });
    expect(performance.now() - t).toBeLessThan(100);
  });
});
