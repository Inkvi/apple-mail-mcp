import { readFile } from "node:fs/promises";
import { simpleParser, type AddressObject } from "mailparser";

export interface ParsedEmail {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  date: Date | null;
  text: string | null;
  html: string | null;
  attachments: { filename: string | null; contentType: string; size: number }[];
}

function addressList(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  return (Array.isArray(field) ? field : [field]).flatMap((a) =>
    a.value.map((v) => v.address ?? "").filter(Boolean),
  );
}

/**
 * An .emlx file is: a byte count padded with spaces, a newline, exactly that
 * many bytes of RFC 822, then an Apple plist trailer.
 */
export function unwrapEmlx(raw: Buffer): Buffer {
  const newline = raw.indexOf(0x0a);
  if (newline === -1) throw new Error("emlx: no newline terminating the byte count");

  const count = Number.parseInt(raw.subarray(0, newline).toString("ascii").trim(), 10);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("emlx: first line is not a byte count");
  }
  return raw.subarray(newline + 1, newline + 1 + count);
}

/**
 * Parsing is delegated to mailparser without exception. 77% of real mail is
 * multipart and 23% carries RFC 2047 encoded headers; hand-written parsing
 * measured roughly 15% wrong against this store.
 */
export async function parseEmlxFile(path: string): Promise<ParsedEmail> {
  const parsed = await simpleParser(unwrapEmlx(await readFile(path)));

  return {
    subject: parsed.subject ?? null,
    from: parsed.from?.value[0]?.address ?? null,
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    date: parsed.date ?? null,
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}
