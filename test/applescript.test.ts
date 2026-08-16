import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { escapeAppleScript, runAppleScript } from "../src/mail/applescript";

describe("escapeAppleScript", () => {
  test("escapes backslashes before quotes so the order cannot be inverted", () => {
    expect(escapeAppleScript(String.raw`a\b`)).toBe(String.raw`a\\b`);
    expect(escapeAppleScript('say "hi"')).toBe(String.raw`say \"hi\"`);
    expect(escapeAppleScript(String.raw`\"`)).toBe(String.raw`\\\"`);
  });

  test("neutralizes newlines that would otherwise start a new statement", () => {
    expect(escapeAppleScript("a\nb")).not.toContain("\n");
    expect(escapeAppleScript("a\r\nb")).not.toContain("\r");
  });

  test("leaves ordinary text and non-ASCII alone", () => {
    expect(escapeAppleScript("Hello there")).toBe("Hello there");
    expect(escapeAppleScript("Вся почта")).toBe("Вся почта");
  });

  test("a string shaped like AppleScript stays inert", () => {
    const attack = '" \n tell application "Finder" to delete every item \n set x to "';
    const escaped = escapeAppleScript(attack);
    expect(escaped).not.toContain("\n");
    expect(escaped.match(/(?<!\\)"/)).toBeNull();
  });
});

describe("runAppleScript", () => {
  test("returns stdout for a trivial script", async () => {
    expect((await runAppleScript('return "pong"')).trim()).toBe("pong");
  });

  test("rejects with stderr attached on a script error", async () => {
    await expect(runAppleScript("this is not applescript")).rejects.toThrow();
  });

  test("rejects on timeout rather than hanging", async () => {
    await expect(runAppleScript("delay 5", 300)).rejects.toThrow(/timed out/i);
  });

  test("an escaped hostile payload embedded in a literal round-trips as data, not code", async () => {
    const canary = `${tmpdir()}/applescript-injection-canary-${Date.now()}`;
    const attack = `" & (do shell script "touch ${canary}") & "`;
    const out = await runAppleScript(`return "${escapeAppleScript(attack)}"`);
    expect(out.trim()).toBe(attack);
    expect(existsSync(canary)).toBe(false);
  });
});
