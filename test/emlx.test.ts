import { test, expect, describe } from "bun:test";
import { unwrapEmlx, parseEmlxFile } from "../src/store/emlx";
import { findStoreRoot } from "../src/store/paths";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

describe("unwrapEmlx", () => {
  test("strips the byte count line and the trailing plist", () => {
    const body = "Subject: hi\r\n\r\nhello";
    const raw = Buffer.from(`${body.length}\n${body}<?xml version="1.0"?><plist/>`);
    expect(unwrapEmlx(raw).toString()).toBe(body);
  });

  test("tolerates the space padding Mail writes after the count", () => {
    const body = "Subject: hi\r\n\r\nhello";
    const raw = Buffer.from(`${body.length}     \n${body}<?xml?>`);
    expect(unwrapEmlx(raw).toString()).toBe(body);
  });

  test("throws on a missing byte count rather than returning junk", () => {
    expect(() => unwrapEmlx(Buffer.from("no newline here"))).toThrow();
    expect(() => unwrapEmlx(Buffer.from("notanumber\nbody"))).toThrow();
  });
});

describe("parseEmlxFile against synthetic fixtures", () => {
  const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

  test("parses a multipart message into text and html parts", async () => {
    const m = await parseEmlxFile(fixture("multipart.emlx"));
    expect(m.subject).toBe("Quarterly plan");
    expect(m.from).toBe("alice@example.com");
    expect(m.to).toEqual(["bob@example.com"]);
    expect(m.cc).toEqual(["carol@example.com"]);
    expect(m.date?.toISOString()).toBe("2026-08-15T10:00:00.000Z");
    expect(m.text?.trim()).toBe("The plan is on track.");
    expect(m.html).toContain("<b>on track</b>");
    expect(m.attachments).toEqual([]);
  });

  test("decodes an RFC 2047 encoded subject to its real text", async () => {
    const m = await parseEmlxFile(fixture("encodedHeader.emlx"));
    expect(m.subject).toBe("Héllo Wörld");
  });

  test("decodes quoted-printable, including =3D and soft line breaks", async () => {
    const m = await parseEmlxFile(fixture("quotedPrintable.emlx"));
    expect(m.text?.trim()).toBe("Total = 42 and this line is soft-wrapped.");
  });

  test("decodes a base64 body", async () => {
    const m = await parseEmlxFile(fixture("base64.emlx"));
    expect(m.text?.trim()).toBe("Numbers speak louder than words.");
  });

  test("decodes an iso-8859-1 body to the right characters", async () => {
    const m = await parseEmlxFile(fixture("latin1.emlx"));
    expect(m.text?.trim()).toBe("café olé");
  });

  test("reads a truncated .partial.emlx without throwing", async () => {
    const m = await parseEmlxFile(fixture("partial.partial.emlx"));
    expect(m.subject).toBe("Big message");
    expect(m.text).toContain("The download stopped");
  });
});

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

describeIfStore("parseEmlxFile against the real store", () => {
  test("a sample of real messages parses with no encoding residue", async () => {
    const limit = 200;
    const problems: string[] = [];
    let parsed = 0;

    for (const file of walkEmlx(storeRoot!)) {
      if (parsed >= limit) break;
      try {
        const m = await parseEmlxFile(file);
        if (/=\?[\w-]+\?[BQbq]\?/.test(m.subject ?? "")) {
          problems.push(`${file}: encoded-word residue in subject`);
        }
        if (/=3D/.test(m.text ?? "")) {
          problems.push(`${file}: quoted-printable residue in text`);
        }
      } catch (err) {
        problems.push(`${file}: threw ${String(err)}`);
      }
      parsed++;
    }

    console.log(`parsed ${parsed} real messages`);
    expect(problems).toEqual([]);
    expect(parsed).toBeGreaterThan(0);
  }, 60_000);
});
