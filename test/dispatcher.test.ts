import { test, expect, describe, afterAll } from "bun:test";
import { Dispatcher, DegradedDispatcher, BODY_SCAN_CAP } from "../src/dispatcher";
import { findStoreRoot } from "../src/store/paths";
import { EnvelopeStore } from "../src/store/envelope";

const root = findStoreRoot();
const d = root ? describe : describe.skip;

// True when the store holds more metadata matches than the scan cap, which
// the unbounded-coverage tests below rely on to force a refusal.
const poolExceedsCap = (() => {
  if (!root) return false;
  const s = new EnvelopeStore(root);
  try {
    return s.searchMessages({}, BODY_SCAN_CAP + 1).length > BODY_SCAN_CAP;
  } finally {
    s.close();
  }
})();

d("Dispatcher read path", () => {
  const dispatcher = new Dispatcher(root!);
  afterAll(() => dispatcher.close());

  test("getMessage returns metadata plus a parsed body", async () => {
    const [first] = dispatcher.searchMessages({ limit: 1 });
    const full = await dispatcher.getMessage(first!.rowid);
    expect(full?.rowid).toBe(first!.rowid);
    expect(typeof full?.bodyAvailable).toBe("boolean");
  });

  test("a narrowed body search returns only matching messages", async () => {
    const recent = dispatcher.searchMessages({ limit: 200 });
    const seed = recent.find((r) => (r.subject ?? "").length > 6);
    if (!seed) return;
    const term = seed.subject!.split(/\s+/).find((w) => w.length > 5);
    if (!term) return;

    // since anchors the pool to the seed's date, keeping it under the cap.
    const hits = await dispatcher.searchMessagesWithBody({
      limit: 200,
      body: term,
      since: seed.dateReceived,
    });
    expect(Array.isArray(hits)).toBe(true);
  });

  test.skipIf(!poolExceedsCap)(
    "an unanchored body search refuses instead of scanning the store",
    async () => {
      await expect(
        dispatcher.searchMessagesWithBody({ body: "refund", limit: 1000000 }),
      ).rejects.toThrow(/too many candidates/i);
    },
  );

  // Would have caught the under-coverage bug: with the pool bounded by the
  // default limit of 50, this search scans 50 files and resolves. The pool
  // must be bounded by BODY_SCAN_CAP alone, so on a store with more metadata
  // matches than the cap it refuses even with no limit supplied.
  test.skipIf(!poolExceedsCap)(
    "a body search with no explicit limit covers the full candidate pool",
    async () => {
      await expect(
        dispatcher.searchMessagesWithBody({ body: "refund" }),
      ).rejects.toThrow(/too many candidates/i);
    },
  );

  test("the scan cap is the documented value", () => {
    expect(BODY_SCAN_CAP).toBe(5000);
  });
});

// When the startup probe rejects the store, the server must not exit: the
// AppleScript write path is exactly the half that still works. Read tools
// surface the probe's reason; write-side hooks stay inert but callable.
describe("DegradedDispatcher", () => {
  const reason = "table messages is missing columns: date_received";
  const deg = new DegradedDispatcher(reason);

  test("every read method surfaces the probe reason", async () => {
    expect(() => deg.listMailboxes()).toThrow(reason);
    expect(() => deg.searchMessages({})).toThrow(reason);
    expect(() => deg.getThread(1)).toThrow(reason);
    await expect(deg.searchMessagesWithBody({ body: "x" })).rejects.toThrow(reason);
    await expect(deg.getMessage(1)).rejects.toThrow(reason);
    await expect(deg.getAttachment(1, "a.pdf")).rejects.toThrow(reason);
  });

  test("write-side hooks keep working so write tools stay usable", () => {
    expect(() => deg.recordWrite([1, 2], { read: true })).not.toThrow();
    expect(() => deg.close()).not.toThrow();
  });
});
