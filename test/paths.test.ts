import { test, expect, describe } from "bun:test";
import { shardFor, mailboxDir, findStoreRoot } from "../src/store/paths";
import { readdirSync, statSync } from "node:fs";
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
