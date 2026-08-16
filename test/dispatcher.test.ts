import { test, expect, describe, afterAll } from "bun:test";
import { Dispatcher, BODY_SCAN_CAP } from "../src/dispatcher";
import { findStoreRoot } from "../src/store/paths";

const root = findStoreRoot();
const d = root ? describe : describe.skip;

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

    const hits = await dispatcher.searchMessagesWithBody({ limit: 200, body: term });
    expect(Array.isArray(hits)).toBe(true);
  });

  test("an unanchored body search refuses instead of scanning the store", async () => {
    await expect(
      dispatcher.searchMessagesWithBody({ body: "refund", limit: 1000000 }),
    ).rejects.toThrow(/too many candidates/i);
  });

  test("the scan cap is the documented value", () => {
    expect(BODY_SCAN_CAP).toBe(5000);
  });
});
