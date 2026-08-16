import { test, expect, describe } from "bun:test";
import { buildDraftScript, buildUpdateDraftScript, buildDeleteDraftScript } from "../src/mail/mutations";

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

describe("buildDeleteDraftScript", () => {
  test("targets the drafts mailbox only, by id", () => {
    const s = buildDeleteDraftScript(42);
    expect(s).toContain("every message of drafts mailbox whose id is 42");
    expect(s).not.toContain("every mailbox");
  });

  test("uses the delete command, never deleted status", () => {
    const s = buildDeleteDraftScript(42);
    expect(s).toContain("delete m");
    expect(s).not.toContain("deleted status");
  });

  test("rejects a non-integer id", () => {
    expect(() => buildDeleteDraftScript(1.5)).toThrow(/integer/);
  });

  test("has no send capability", () => {
    expect(buildDeleteDraftScript(42).toLowerCase()).not.toContain("send ");
  });
});

describe("buildUpdateDraftScript", () => {
  const spec = { to: ["a@b.c"], cc: ["g@h.i"], subject: "Re: S", body: "one\ntwo" };

  test("guards on existence, creates the replacement, then deletes the old draft, in that order", () => {
    const s = buildUpdateDraftScript(42, spec);
    const guard = s.indexOf("if (count of oldDrafts) is 0 then return 0");
    const create = s.indexOf("make new outgoing message");
    const del = s.indexOf("delete m");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
    expect(del).toBeGreaterThan(create);
  });

  test("finds the old draft only in the drafts mailbox", () => {
    const s = buildUpdateDraftScript(42, spec);
    expect(s).toContain("every message of drafts mailbox whose id is 42");
  });

  test("carries subject, recipients, and the multi-line body", () => {
    const s = buildUpdateDraftScript(42, spec);
    expect(s).toContain(`subject:"Re: S"`);
    expect(s).toContain(`content:"one" & return & "two"`);
    expect(s).toContain("a@b.c");
    expect(s).toContain("g@h.i");
    expect(s).toContain("cc recipient");
  });

  test("deletes the old draft with the delete command, never deleted status", () => {
    const s = buildUpdateDraftScript(42, spec);
    expect(s).toContain("delete m");
    expect(s).not.toContain("deleted status");
  });

  test("rejects an empty recipient list and a non-integer id", () => {
    expect(() => buildUpdateDraftScript(42, { to: [], subject: "S", body: "B" })).toThrow(/recipient/i);
    expect(() => buildUpdateDraftScript(1.5, spec)).toThrow(/integer/);
  });

  test("has no send capability", () => {
    expect(buildUpdateDraftScript(42, spec).toLowerCase()).not.toContain("send ");
  });
});
