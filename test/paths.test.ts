import { test, expect, describe } from "bun:test";
import { shardFor, mailboxDir, findStoreRoot, resolveMessageFile } from "../src/store/paths";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("shardFor", () => {
  test("reverses the digits above the thousands boundary", () => {
    expect(shardFor(159566)).toBe("9/5/1");
    expect(shardFor(204121)).toBe("4/0/2");
    expect(shardFor(167410)).toBe("7/6/1");
  });

  test("returns empty for ids below 1000, meaning an unsharded Data/Messages", () => {
    expect(shardFor(133)).toBe("");
    expect(shardFor(999)).toBe("");
    expect(shardFor(0)).toBe("");
  });

  test("handles the two-level case", () => {
    expect(shardFor(59123)).toBe("9/5");
  });
});

describe("mailboxDir", () => {
  test("appends .mbox per decoded segment and preserves account uuid case", () => {
    const d = mailboxDir("/root", "imap://11111111-2222-4000-8000-333333333333/%5BGmail%5D/All%20Mail");
    expect(d).toBe("/root/11111111-2222-4000-8000-333333333333/[Gmail].mbox/All Mail.mbox");
  });

  test("handles a single top level mailbox", () => {
    const d = mailboxDir("/root", "imap://ABC-123/INBOX");
    expect(d).toBe("/root/ABC-123/INBOX.mbox");
  });
});

describe("resolveMessageFile uuid caching", () => {
  // The server is long-running. A mailbox whose uuid directory does not
  // exist yet (new mailbox, account just enabled) must be found on a later
  // lookup once it appears, so a failed lookup must never be cached.
  test("a mailbox that appears after a failed lookup is found on retry", () => {
    const root = mkdtempSync(join(tmpdir(), "mail-paths-"));
    try {
      const url = "imap://TEST-ACCT/INBOX";
      expect(resolveMessageFile(root, url, 42)).toBeNull();

      const messages = join(root, "TEST-ACCT", "INBOX.mbox", "12345678-ABCD-4000-8000-000000000000", "Data", "Messages");
      mkdirSync(messages, { recursive: true });
      const emlx = join(messages, "42.emlx");
      writeFileSync(emlx, "6\nx: y\n\n");

      expect(resolveMessageFile(root, url, 42)?.path).toBe(emlx);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Walk every .emlx and assert the derived shard matches the actual one. */
function* walkEmlx(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const p = join(dir, entry);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) yield* walkEmlx(p);
    else if (entry.endsWith(".emlx")) yield p;
  }
}

const storeRoot = findStoreRoot();
const describeIfStore = storeRoot ? describe : describe.skip;

describeIfStore("shard rule against the real store", () => {
  test("every .emlx on disk sits at its derived shard path", () => {
    let checked = 0;
    const mismatches: string[] = [];
    for (const file of walkEmlx(storeRoot!)) {
      const stem = file.split("/").pop()!.replace(".partial", "").replace(".emlx", "");
      if (!/^\d+$/.test(stem)) continue;
      const rowid = Number(stem);
      const parts = file.split("/");
      const dataAt = parts.lastIndexOf("Data");
      const msgsAt = parts.lastIndexOf("Messages");
      const actual = parts.slice(dataAt + 1, msgsAt).join("/");
      if (actual !== shardFor(rowid)) mismatches.push(`${rowid}: ${actual} != ${shardFor(rowid)}`);
      checked++;
    }
    console.log(`shard rule checked against ${checked} files`);
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
