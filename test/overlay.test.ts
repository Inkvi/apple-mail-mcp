import { test, expect, describe } from "bun:test";
import { WriteOverlay } from "../src/coherence/overlay";
import type { MessageRow } from "../src/types";

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  rowid: 1, messageIdHeader: null, subject: "s", sender: "a@b.c",
  mailboxUrl: "imap://ACC/INBOX", dateReceived: 0, dateSent: null,
  read: false, flagged: false, size: 0, conversationId: 0, attachmentCount: 0,
  ...over,
});

describe("WriteOverlay", () => {
  test("a pending write shows through on a stale row", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    expect(o.apply(row({ flagged: false })).flagged).toBe(true);
  });

  test("rows without a pending write are untouched", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    expect(o.apply(row({ rowid: 2, flagged: false })).flagged).toBe(false);
  });

  test("the entry is dropped once the database agrees", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    expect(o.size()).toBe(1);
    o.reconcile([row({ flagged: true })]);
    expect(o.size()).toBe(0);
  });

  test("the entry survives while the database still disagrees", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    o.reconcile([row({ flagged: false })]);
    expect(o.size()).toBe(1);
  });

  test("an expired entry stops applying", async () => {
    const o = new WriteOverlay(50);
    o.record(1, { flagged: true });
    await Bun.sleep(80);
    expect(o.apply(row({ flagged: false })).flagged).toBe(false);
    expect(o.size()).toBe(0);
  });

  test("later writes merge over earlier ones for the same message", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    o.record(1, { read: true });
    const r = o.apply(row());
    expect(r.flagged).toBe(true);
    expect(r.read).toBe(true);
  });
});
