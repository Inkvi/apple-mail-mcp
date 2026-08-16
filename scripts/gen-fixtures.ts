// Generates the synthetic .emlx fixtures in test/fixtures. No real mail is
// ever read or copied; every message below is hand-authored. Rerun with:
//   bun run scripts/gen-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "../test/fixtures");
mkdirSync(outDir, { recursive: true });

const plist =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<plist version="1.0"><dict><key>flags</key><integer>0</integer></dict></plist>\n';

/** Wrap an RFC 822 payload in the .emlx envelope: byte count, newline, payload, plist. */
function writeEmlx(name: string, payload: Buffer): void {
  const wrapped = Buffer.concat([
    Buffer.from(`${payload.length}\n`, "ascii"),
    payload,
    Buffer.from(plist, "utf8"),
  ]);
  writeFileSync(join(outDir, name), wrapped);
  console.log(`${name}: ${payload.length} byte payload`);
}

const crlf = (s: string) => s.replaceAll("\n", "\r\n");

writeEmlx(
  "multipart.emlx",
  Buffer.from(
    crlf(
      `From: Alice Example <alice@example.com>
To: Bob Example <bob@example.com>
Subject: Quarterly plan
Date: Fri, 15 Aug 2026 10:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8

The plan is on track.
--b1
Content-Type: text/html; charset=utf-8

<html><body><p>The plan is <b>on track</b>.</p></body></html>
--b1--
`,
    ),
    "utf8",
  ),
);

const encodedSubject = `=?UTF-8?B?${Buffer.from("Héllo Wörld", "utf8").toString("base64")}?=`;
writeEmlx(
  "encodedHeader.emlx",
  Buffer.from(
    crlf(
      `From: Alice Example <alice@example.com>
To: bob@example.com
Subject: ${encodedSubject}
Date: Fri, 15 Aug 2026 10:01:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Greetings.
`,
    ),
    "utf8",
  ),
);

writeEmlx(
  "quotedPrintable.emlx",
  Buffer.from(
    crlf(
      `From: alice@example.com
To: bob@example.com
Subject: Invoice
Date: Fri, 15 Aug 2026 10:02:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Total =3D 42 and this line is soft-=
wrapped.
`,
    ),
    "utf8",
  ),
);

writeEmlx(
  "base64.emlx",
  Buffer.from(
    crlf(
      `From: alice@example.com
To: bob@example.com
Subject: Attachment note
Date: Fri, 15 Aug 2026 10:03:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

${Buffer.from("Numbers speak louder than words.", "utf8").toString("base64")}
`,
    ),
    "utf8",
  ),
);

writeEmlx(
  "latin1.emlx",
  Buffer.concat([
    Buffer.from(
      crlf(
        `From: alice@example.com
To: bob@example.com
Subject: Menu
Date: Fri, 15 Aug 2026 10:04:00 +0000
MIME-Version: 1.0
Content-Type: text/plain; charset=iso-8859-1

`,
      ),
      "utf8",
    ),
    Buffer.from("caf\xe9 ol\xe9\r\n", "latin1"),
  ]),
);

// A message cut off mid body, the way Mail leaves .partial.emlx files when
// the full body has not been downloaded. The byte count still matches the
// bytes actually present.
writeEmlx(
  "partial.partial.emlx",
  Buffer.from(
    crlf(
      `From: alice@example.com
To: bob@example.com
Subject: Big message
Date: Fri, 15 Aug 2026 10:05:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="b2"

--b2
Content-Type: text/plain; charset=utf-8

The download stopped right about he`,
    ),
    "utf8",
  ),
);
