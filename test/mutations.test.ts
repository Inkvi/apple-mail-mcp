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

  test("flag scripts carry the boolean through", () => {
    expect(buildFlagScript([7], true)).toContain("true");
    expect(buildFlagScript([7], false)).toContain("false");
  });

  test("delete moves to trash rather than erasing", () => {
    const s = buildDeleteScript([9]);
    expect(s.toLowerCase()).toContain("trash");
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
