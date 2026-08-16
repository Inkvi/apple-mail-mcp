import { test, expect, describe } from "bun:test";
import { buildDraftScript } from "../src/mail/mutations";

describe("buildDraftScript", () => {
  test("creates a draft without sending it", () => {
    const s = buildDraftScript({ to: ["a@b.c"], subject: "Hi", body: "Hello" });
    expect(s).toContain("make new outgoing message");
    expect(s).toContain("visible:true");
    expect(s.toLowerCase()).not.toContain("send ");
  });

  test("adds every recipient", () => {
    const s = buildDraftScript({ to: ["a@b.c", "d@e.f"], cc: ["g@h.i"], subject: "S", body: "B" });
    expect(s).toContain("a@b.c");
    expect(s).toContain("d@e.f");
    expect(s).toContain("g@h.i");
    expect(s).toContain("cc recipient");
  });

  test("escapes subject and body", () => {
    const s = buildDraftScript({ to: ["a@b.c"], subject: 'He said "no"', body: "line1\nline2" });
    expect(s).toContain(String.raw`He said \"no\"`);
    expect(s).not.toMatch(/[^\\]\nline2/);
  });

  test("rejects an empty recipient list", () => {
    expect(() => buildDraftScript({ to: [], subject: "S", body: "B" })).toThrow(/recipient/i);
  });

  test("rebuilds a multi-line body with the return operator", () => {
    const s = buildDraftScript({ to: ["a@b.c"], subject: "S", body: "one\ntwo\r\nthree" });
    expect(s).toContain(`"one" & return & "two" & return & "three"`);
    // No raw newline may survive inside the content expression.
    const content = s.match(/content:(.*?), visible/)?.[1];
    expect(content).toBeDefined();
    expect(content).not.toContain("\n");
  });

  test("an empty body still yields a valid string expression", () => {
    const s = buildDraftScript({ to: ["a@b.c"], subject: "S", body: "" });
    expect(s).toContain(`content:""`);
  });

  test("a body of only newlines yields joined empty literals", () => {
    const s = buildDraftScript({ to: ["a@b.c"], subject: "S", body: "\n" });
    expect(s).toContain(`content:"" & return & ""`);
  });
});
