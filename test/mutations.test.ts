import { test, expect, describe } from "bun:test";
import { buildMarkReadScript, buildMoveScript, buildFlagScript, buildDeleteScript } from "../src/mail/mutations";

describe("script generation", () => {
  test("mark read targets every id in one pass", () => {
    const s = buildMarkReadScript([101, 202], true);
    expect(s).toContain("101");
    expect(s).toContain("202");
    expect(s).toContain("read status");
    expect(s).toContain("true");
  });

  test("mark unread carries false through", () => {
    const s = buildMarkReadScript([5], false);
    expect(s).toContain("set read status of m to false");
  });

  test("flag scripts carry the boolean through", () => {
    expect(buildFlagScript([7], true)).toContain("true");
    expect(buildFlagScript([7], false)).toContain("false");
  });

  // `set deleted status of m to true` was the original form here. It raises
  // error -609 against Gmail IMAP for ordinary messages and drafts alike, so
  // the delete verb is the only one that works on both. Verified live
  // 2026-08-16: deleting from All Mail produced a new row in Trash, so this
  // still moves to Trash rather than erasing.
  test("delete uses the verb that works, not the deleted-status flag", () => {
    const s = buildDeleteScript([9]);
    expect(s).toContain("delete m");
    expect(s).not.toContain("set deleted status");
  });

  // Mail accepts `whose id is in {1, 2}` without complaint and matches
  // nothing, which silently turned every write tool into a no-op. Verified
  // live 2026-08-16 against a message `id is <n>` found in the same run.
  test("ids are matched by an or chain, never by `is in` a list", () => {
    const s = buildMarkReadScript([101, 202], true);
    expect(s).toContain("id is 101 or id is 202");
    expect(s).not.toMatch(/is\s+in\s*\{/);
  });

  // Walking hits forwards renumbers the collection under the loop once a
  // move or delete removes a message from it: error -10000, live 2026-08-16.
  test("hits are walked backwards so mutation cannot renumber the loop", () => {
    for (const s of [buildDeleteScript([9]), buildMoveScript([9], "Box", "Acct")]) {
      expect(s).toContain("repeat with i from (count of hits) to 1 by -1");
    }
  });

  test("move resolves the destination before mutating", () => {
    const s = buildMoveScript([3], "Archive", "iCloud");
    expect(s).toContain('set destination to mailbox "Archive" of account "iCloud"');
    expect(s).toContain("move m to destination");
    expect(s.indexOf("set destination")).toBeLessThan(s.indexOf("move m to destination"));
  });

  test("mailbox and account names are escaped", () => {
    const s = buildMoveScript([1], 'Ev"il\nBox', "Acc\\ount");
    expect(s).not.toMatch(/[\r\n]Ev/);
    expect(s).toContain(String.raw`Ev\"il`);
    expect(s).toContain(String.raw`Acc\\ount`);
  });

  test("an empty id list produces no script", () => {
    expect(() => buildMarkReadScript([], true)).toThrow(/no message ids/i);
  });

  test("non-integer ids are rejected before reaching AppleScript", () => {
    expect(() => buildMarkReadScript([1.5], true)).toThrow(/integer/i);
    expect(() => buildMarkReadScript([Number.NaN], true)).toThrow(/integer/i);
  });
});
