import { test, expect, describe } from "bun:test";
import { composeReply, composeForward, type ComposeSource } from "../src/mail/compose";

const original: ComposeSource = {
  subject: "Quarterly plan",
  sender: "alice@example.com",
  dateReceived: 1_755_252_000,
  text: "line one\nline two",
  to: ["bob@example.com", "carol@example.com"],
};

describe("composeReply", () => {
  test("prefixes the original subject with Re:", () => {
    const r = composeReply(original, "ignored default", "Thanks!");
    expect(r.subject).toBe("Re: Quarterly plan");
  });

  test("never double-prefixes an original already starting with Re:", () => {
    const r = composeReply({ ...original, subject: "Re: Quarterly plan" }, "x", "b");
    expect(r.subject).toBe("Re: Quarterly plan");
  });

  test("keeps a requested subject that is already a Re:", () => {
    const r = composeReply(original, "Re: something else", "b");
    expect(r.subject).toBe("Re: something else");
  });

  test("quotes every line of the original under the new body", () => {
    const r = composeReply(original, "s", "Thanks!");
    expect(r.body.startsWith("Thanks!")).toBe(true);
    expect(r.body).toContain("alice@example.com wrote:");
    expect(r.body).toContain("> line one");
    expect(r.body).toContain("> line two");
  });
});

describe("composeForward", () => {
  test("prefixes the original subject with Fwd:", () => {
    const f = composeForward(original, "ignored default", "FYI");
    expect(f.subject).toBe("Fwd: Quarterly plan");
  });

  test("never double-prefixes an original already starting with Fwd:", () => {
    const f = composeForward({ ...original, subject: "Fwd: Quarterly plan" }, "x", "b");
    expect(f.subject).toBe("Fwd: Quarterly plan");
  });

  test("keeps a requested subject that is already a Fwd:", () => {
    const f = composeForward(original, "Fwd: something else", "b");
    expect(f.subject).toBe("Fwd: something else");
  });

  test("carries the original headers and full text below the new body", () => {
    const f = composeForward(original, "s", "FYI");
    expect(f.body.startsWith("FYI")).toBe(true);
    expect(f.body).toContain("Begin forwarded message:");
    expect(f.body).toContain("From: alice@example.com");
    expect(f.body).toContain("Subject: Quarterly plan");
    expect(f.body).toContain("To: bob@example.com, carol@example.com");
    expect(f.body).toContain("line one\nline two");
  });

  test("tolerates a message with no sender, no subject, and no body text", () => {
    const bare: ComposeSource = { subject: null, sender: null, dateReceived: 0, text: null, to: [] };
    const f = composeForward(bare, "My subject", "FYI");
    expect(f.subject).toBe("My subject");
    expect(f.body).toContain("Begin forwarded message:");
  });
});
