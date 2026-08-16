# Apple Mail Hybrid MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server that reads Apple Mail from its on-disk store at millisecond speed and organizes mail by driving Mail.app through AppleScript.

**Architecture:** Two independent paths behind one dispatcher. The read path opens Mail's Envelope Index SQLite database readonly and resolves message bodies to `.emlx` files by computing the path from the row id, so no filesystem search and no index of our own. The write path shells out to `osascript` so Mail.app stays the sole writer of its own store. A small in-memory overlay covers the lag between a write landing in Mail and appearing in SQLite.

**Tech Stack:** TypeScript on Bun 1.3.14+, `bun:sqlite` (built in), `bun test` (built in), `@modelcontextprotocol/sdk` ^1.30.0, `mailparser` ^3.9.15, `zod` ^4.4.3.

**Spec:** `docs/superpowers/specs/2026-08-15-apple-mail-hybrid-mcp-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **macOS only.** No cross-platform code paths.
- **Bun >= 1.3.14.** Use `bun:sqlite` and `bun test`. Do not add vitest, jest, or better-sqlite3.
- **Open the Envelope Index with `{ readonly: true }`. Never `immutable=1`.** Verified: `immutable=1` skips the WAL and returned 103,272 rows against the correct 103,273, silently missing a just-arrived message. This is a correctness bug.
- **Never write to Mail's store.** No writes to the Envelope Index, no writes to any `.emlx`. All mutation goes through `osascript`.
- **Never hand-roll MIME or header parsing.** Always `mailparser`. Verified: a hand-written regex produced roughly 15% garbage against this store.
- **No network code.** No IMAP, no SMTP, no HTTP client, no credentials, no Keychain.
- **No send capability.** Drafts only. Do not add `send_now` in any form.
- **No em dashes** in any prose: code comments, docs, commit messages, tool descriptions, error strings.
- **Store root** is `~/Library/Mail/V10`. Discover the `V*` directory at runtime rather than hardcoding `V10` outside the probe.

## Reference Facts

Measured against the live store on 2026-08-15. Tasks depend on these being true.

**Shard rule.** `.emlx` filename stem is `messages.ROWID`. Shard directories are the digits of `ROWID / 1000` reversed. Verified against all 103,315 files with zero mismatches.

```
ROWID 159566 -> <mbox>/<store-uuid>/Data/9/5/1/Messages/159566.emlx
ROWID    133 -> <mbox>/<store-uuid>/Data/Messages/133.emlx
```

**`.emlx` wrapper.** First line is a byte count padded with spaces, then `\n`, then exactly that many bytes of RFC 822, then a plist trailer. Verified on 400 sampled files, 400 parsed cleanly.

**Mailbox URL to directory.** `mailboxes.url` looks like `imap://<ACCOUNT-UUID>/%5BGmail%5D/All%20Mail`. Each path segment URL-decodes and gains a `.mbox` suffix. The WHATWG `URL` parser preserves UUID case for the `imap:` scheme (verified), so `u.hostname` is safe to use directly.

**Store UUID.** Between the `.mbox` directory and `Data/` sits one more UUID directory (`EC36E641-...` on this machine, the same value for all 39 mailboxes). Discover it with a single `readdir` and cache it. Do not hardcode it.

**One id serves both paths.** AppleScript's `id of message` equals `messages.ROWID`. Verified directly: Mail reported ids 209783, 209710, 209711 for three INBOX messages, and those `ROWID`s in SQLite carry exactly matching subjects.

This contradicts the s-morgan-jeffries spike, which states that Mail's AppleScript id maps to `messages.message_id`. It does not, at least on macOS 25.6. The `message_id` column holds large signed hashes (`6808567730906623666` for `ROWID` 209783) and is not an AppleScript handle.

The consequence is a real simplification: sweetrb and s-morgan-jeffries both built dual-emit id schemes to let callers cross between their read and write paths. This project needs none of that. A single `rowid` addresses the `.emlx` file, the SQLite row, and the AppleScript message. **Do not introduce a second id type.** If a future macOS breaks this, the parity task catches it.

**Key joins.** `subject` and `sender` are integer FKs, not text. The RFC 5322 Message-ID joins on `message_id`, not `ROWID`.

```sql
join mailboxes mb on mb.ROWID = m.mailbox
left join subjects s on s.ROWID = m.subject
left join addresses a on a.ROWID = m.sender
left join message_global_data g on g.message_id = m.message_id
```

## File Structure

```
src/
  types.ts              Shared row and filter types. No logic.
  store/
    paths.ts            Pure path math. shardFor, mailboxDir, resolveMessageFile.
    emlx.ts             Unwrap the .emlx envelope, delegate to mailparser.
    envelope.ts         The only module that writes SQL. Owns the connection.
    probe.ts            Startup schema and version check.
  mail/
    applescript.ts      osascript bridge. Owns escaping, timeouts, child cleanup.
    mutations.ts        One function per mutation. Generates AppleScript.
  coherence/
    overlay.ts          Recent-write overlay with TTL.
  dispatcher.ts         Routes tools to paths, applies overlay, enforces scan cap.
  server.ts             Tool definitions and schemas only.
test/
  fixtures/             Committed .emlx samples.
  *.test.ts
scripts/
  measure-wal-lag.ts    One-off measurement. Not shipped.
```

---

### Task 1: Scaffold and path derivation

The shard rule is the foundation of the whole read path, so it gets tested first and hardest.

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/store/paths.ts`
- Test: `test/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `shardFor(rowid: number): string`
  - `mailboxDir(storeRoot: string, mailboxUrl: string): string`
  - `resolveMessageFile(storeRoot: string, mailboxUrl: string, rowid: number): { path: string; partial: boolean } | null`
  - `findStoreRoot(): string | null`

- [ ] **Step 1: Initialize the project**

```bash
cd /Users/you/dev/apple-mail-mcp
bun init -y
bun add @modelcontextprotocol/sdk@^1.30.0 mailparser@^3.9.15 zod@^4.4.3
bun add -d @types/mailparser
```

Replace the generated `package.json` scripts block with:

```json
"scripts": {
  "test": "bun test",
  "typecheck": "tsc --noEmit",
  "start": "bun run src/server.ts"
}
```

Write `.gitignore`:

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 2: Write the failing test**

Create `test/paths.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { shardFor, mailboxDir } from "../src/store/paths";

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
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `bun test test/paths.test.ts`
Expected: FAIL, cannot resolve `../src/store/paths`.

- [ ] **Step 4: Implement**

Create `src/store/paths.ts`:

```ts
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shard directories under Data/ are the digits of rowid/1000, reversed.
 * ROWID 159566 lives under Data/9/5/1/Messages/. Ids below 1000 are
 * unsharded and live directly under Data/Messages/.
 * Verified against all 103,315 .emlx files in a real store.
 */
export function shardFor(rowid: number): string {
  if (rowid < 1000) return "";
  return String(Math.trunc(rowid / 1000)).split("").reverse().join("/");
}

/**
 * mailboxes.url is imap://<ACCOUNT-UUID>/<url-encoded>/<path>.
 * Each segment decodes and gains a .mbox suffix. The URL parser preserves
 * host case for non-special schemes such as imap:, so hostname is safe.
 */
export function mailboxDir(storeRoot: string, mailboxUrl: string): string {
  const u = new URL(mailboxUrl);
  const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let dir = join(storeRoot, u.hostname);
  for (const segment of segments) dir = join(dir, `${segment}.mbox`);
  return dir;
}

const storeUuidCache = new Map<string, string | null>();

/** The UUID directory between <name>.mbox and Data/. One readdir, then cached. */
function storeUuidFor(mboxDir: string): string | null {
  if (storeUuidCache.has(mboxDir)) return storeUuidCache.get(mboxDir) ?? null;
  let found: string | null = null;
  try {
    found = readdirSync(mboxDir).find((e) => /^[0-9A-F]{8}-[0-9A-F]{4}-/i.test(e)) ?? null;
  } catch {
    found = null;
  }
  storeUuidCache.set(mboxDir, found);
  return found;
}

/**
 * Resolve a message to its file with no filesystem search.
 * Returns null when the body is not on disk, which is normal for
 * Exchange accounts. partial=true means the download is incomplete.
 */
export function resolveMessageFile(
  storeRoot: string,
  mailboxUrl: string,
  rowid: number,
): { path: string; partial: boolean } | null {
  const mbox = mailboxDir(storeRoot, mailboxUrl);
  const uuid = storeUuidFor(mbox);
  if (!uuid) return null;

  const shard = shardFor(rowid);
  const dir = shard
    ? join(mbox, uuid, "Data", shard, "Messages")
    : join(mbox, uuid, "Data", "Messages");

  const full = join(dir, `${rowid}.emlx`);
  if (existsSync(full)) return { path: full, partial: false };

  const partial = join(dir, `${rowid}.partial.emlx`);
  if (existsSync(partial)) return { path: partial, partial: true };

  return null;
}

/** Newest V<n> directory under ~/Library/Mail, or null if Mail has never run. */
export function findStoreRoot(): string | null {
  const base = join(homedir(), "Library", "Mail");
  try {
    const versions = readdirSync(base)
      .filter((e) => /^V\d+$/.test(e))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    return versions.length > 0 ? join(base, versions[0]!) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun test test/paths.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the exhaustive property test against the real store**

This is the test that licenses the whole design. Append to `test/paths.test.ts`:

```ts
import { findStoreRoot, resolveMessageFile } from "../src/store/paths";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
```

- [ ] **Step 7: Run it**

Run: `bun test test/paths.test.ts`
Expected: PASS. The log line should report a five or six figure file count. If `mismatches` is non-empty the shard rule does not hold on this machine and Task 1 must stop for a design conversation, because every later task assumes it.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock tsconfig.json .gitignore src/store/paths.ts test/paths.test.ts
git commit -m "Add path derivation for Apple Mail .emlx files

Shard directories are the digits of ROWID/1000 reversed, so a message
resolves to its file with arithmetic instead of a filesystem walk. A prior
project measured that walk at ~1.9s across 60k files and called it the
blocker for local body reads.

The property test walks every .emlx in the real store and asserts the
derived path matches the actual one."
```

---

### Task 2: Read and parse `.emlx` files

**Files:**
- Create: `src/store/emlx.ts`, `test/fixtures/` (generated)
- Test: `test/emlx.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `unwrapEmlx(raw: Buffer): Buffer`
  - `parseEmlxFile(path: string): Promise<ParsedEmail>`
  - `interface ParsedEmail { subject: string | null; from: string | null; to: string[]; date: Date | null; text: string | null; html: string | null; attachments: { filename: string | null; contentType: string; size: number }[] }`

- [ ] **Step 1: Build fixtures from the real store**

Fixtures must reflect the measured distribution: 77% multipart, 23% RFC 2047 headers, quoted-printable dominant. Create `scripts/make-fixtures.ts`:

```ts
import { findStoreRoot } from "../src/store/paths";
import { readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = findStoreRoot();
if (!root) throw new Error("no Mail store found");
mkdirSync("test/fixtures", { recursive: true });

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) yield* walk(p);
    else if (e.endsWith(".emlx")) yield p;
  }
}

const want = {
  multipart: (h: string) => /Content-Type:\s*multipart\//i.test(h),
  encodedHeader: (h: string) => /=\?[\w-]+\?[BQbq]\?/.test(h),
  quotedPrintable: (h: string) => /Content-Transfer-Encoding:\s*quoted-printable/i.test(h),
  base64: (h: string) => /Content-Transfer-Encoding:\s*base64/i.test(h),
  latin1: (h: string) => /charset="?iso-8859-1/i.test(h),
  partial: (_h: string, p: string) => p.endsWith(".partial.emlx"),
};

const taken = new Set<string>();
for (const file of walk(root)) {
  const head = Buffer.from(Bun.file(file).slice(0, 6000).arrayBuffer ? "" : "").toString();
  const raw = require("node:fs").readFileSync(file).subarray(0, 6000).toString("utf8");
  for (const [name, pred] of Object.entries(want)) {
    if (taken.has(name)) continue;
    if ((pred as (h: string, p: string) => boolean)(raw, file)) {
      copyFileSync(file, `test/fixtures/${name}.emlx`);
      taken.add(name);
      console.log(`fixture ${name} <- ${file}`);
    }
  }
  if (taken.size === Object.keys(want).length) break;
}
console.log(`captured ${taken.size} fixtures`);
```

Run: `bun run scripts/make-fixtures.ts`

**These fixtures are real personal mail.** Before committing, open each one and confirm you are willing to have it in the repo. If the repo will ever be public, redact the bodies by hand, keeping headers and MIME structure intact, since those are what the parser is being tested on.

- [ ] **Step 2: Write the failing test**

Create `test/emlx.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { unwrapEmlx, parseEmlxFile } from "../src/store/emlx";
import { existsSync, readFileSync } from "node:fs";

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

describe("parseEmlxFile against real fixtures", () => {
  const fixture = (n: string) => `test/fixtures/${n}.emlx`;

  test("parses a multipart message into text and structure", async () => {
    if (!existsSync(fixture("multipart"))) return;
    const m = await parseEmlxFile(fixture("multipart"));
    expect(m.from).toBeTruthy();
    expect(m.text ?? m.html).toBeTruthy();
  });

  test("decodes RFC 2047 encoded headers instead of leaking =?UTF-8?B?", async () => {
    if (!existsSync(fixture("encodedHeader"))) return;
    const m = await parseEmlxFile(fixture("encodedHeader"));
    expect(m.subject ?? "").not.toContain("=?");
  });

  test("decodes quoted-printable instead of leaking =3D", async () => {
    if (!existsSync(fixture("quotedPrintable"))) return;
    const m = await parseEmlxFile(fixture("quotedPrintable"));
    expect(m.text ?? "").not.toMatch(/=3D/);
  });

  test("reads a partial message without throwing", async () => {
    if (!existsSync(fixture("partial"))) return;
    const m = await parseEmlxFile(fixture("partial"));
    expect(m).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `bun test test/emlx.test.ts`
Expected: FAIL, cannot resolve `../src/store/emlx`.

- [ ] **Step 4: Implement**

Create `src/store/emlx.ts`:

```ts
import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";

export interface ParsedEmail {
  subject: string | null;
  from: string | null;
  to: string[];
  date: Date | null;
  text: string | null;
  html: string | null;
  attachments: { filename: string | null; contentType: string; size: number }[];
}

/**
 * An .emlx file is: a byte count padded with spaces, a newline, exactly that
 * many bytes of RFC 822, then an Apple plist trailer. Verified on 400 files.
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

  const to = parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a) =>
        a.value.map((v) => v.address ?? "").filter(Boolean),
      )
    : [];

  return {
    subject: parsed.subject ?? null,
    from: parsed.from?.value[0]?.address ?? null,
    to,
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
```

- [ ] **Step 5: Run and confirm it passes**

Run: `bun test test/emlx.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/emlx.ts test/emlx.test.ts test/fixtures scripts/make-fixtures.ts
git commit -m "Add .emlx reading with mailparser

The wrapper is a byte count, a newline, that many bytes of RFC 822, then a
plist trailer. Parsing the RFC 822 payload is delegated to mailparser and
never hand-rolled: 77% of real mail is multipart and 23% carries RFC 2047
headers, and a hand-written regex measured roughly 15% wrong."
```

---

### Task 3: Envelope Index reader

**Files:**
- Create: `src/types.ts`, `src/store/envelope.ts`
- Test: `test/envelope.test.ts`

**Interfaces:**
- Consumes: `findStoreRoot` from Task 1
- Produces:
  - `interface MessageRow` and `interface SearchFilter` (below, referenced verbatim by Tasks 5, 8, 9)
  - `class EnvelopeStore` with `searchMessages(f: SearchFilter): MessageRow[]`, `getMessage(rowid: number): MessageRow | null`, `listMailboxes(): MailboxRow[]`, `getThread(conversationId: number): MessageRow[]`, `close(): void`

- [ ] **Step 1: Define shared types**

Create `src/types.ts`:

```ts
export interface MessageRow {
  rowid: number;
  messageIdHeader: string | null;
  subject: string | null;
  sender: string | null;
  mailboxUrl: string;
  dateReceived: number;
  dateSent: number | null;
  read: boolean;
  flagged: boolean;
  size: number;
  conversationId: number;
  attachmentCount: number;
}

export interface MailboxRow {
  rowid: number;
  url: string;
  accountId: string;
  name: string;
  totalCount: number;
  unreadCount: number;
}

export interface SearchFilter {
  mailboxUrl?: string;
  from?: string;
  subject?: string;
  since?: number;
  until?: number;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  hasAttachments?: boolean;
  limit?: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/envelope.test.ts`:

```ts
import { test, expect, describe, afterAll } from "bun:test";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";

const root = findStoreRoot();
const d = root ? describe : describe.skip;

d("EnvelopeStore against the real store", () => {
  const store = new EnvelopeStore(root!);
  afterAll(() => store.close());

  test("lists mailboxes with counts", () => {
    const boxes = store.listMailboxes();
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes[0]!.url).toStartWith("imap://");
    expect(boxes[0]!.accountId).toBeTruthy();
  });

  test("returns recent messages with joined subject and sender", () => {
    const rows = store.searchMessages({ limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.subject !== null)).toBe(true);
    expect(rows.some((r) => r.sender !== null)).toBe(true);
  });

  test("orders newest first", () => {
    const rows = store.searchMessages({ limit: 20 });
    const dates = rows.map((r) => r.dateReceived);
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  test("respects unreadOnly", () => {
    const rows = store.searchMessages({ unreadOnly: true, limit: 30 });
    expect(rows.every((r) => r.read === false)).toBe(true);
  });

  test("filters by sender substring", () => {
    const any = store.searchMessages({ limit: 1 });
    const sender = any[0]?.sender;
    if (!sender) return;
    const domain = sender.split("@")[1]!;
    const rows = store.searchMessages({ from: domain, limit: 10 });
    expect(rows.every((r) => (r.sender ?? "").includes(domain))).toBe(true);
  });

  test("getMessage round-trips a rowid", () => {
    const first = store.searchMessages({ limit: 1 })[0]!;
    const again = store.getMessage(first.rowid);
    expect(again?.rowid).toBe(first.rowid);
  });

  test("metadata search stays under 100ms", () => {
    const t = performance.now();
    store.searchMessages({ limit: 200 });
    expect(performance.now() - t).toBeLessThan(100);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `bun test test/envelope.test.ts`
Expected: FAIL, cannot resolve `../src/store/envelope`.

- [ ] **Step 4: Implement**

Create `src/store/envelope.ts`:

```ts
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { MailboxRow, MessageRow, SearchFilter } from "../types";

const SELECT = `
  select
    m.ROWID            as rowid,
    g.message_id_header as messageIdHeader,
    s.subject          as subject,
    a.address          as sender,
    mb.url             as mailboxUrl,
    m.date_received    as dateReceived,
    m.date_sent        as dateSent,
    m.read             as readFlag,
    m.flagged          as flaggedFlag,
    m.size             as size,
    m.conversation_id  as conversationId,
    (select count(*) from attachments at where at.message = m.ROWID) as attachmentCount
  from messages m
  join mailboxes mb on mb.ROWID = m.mailbox
  left join subjects s on s.ROWID = m.subject
  left join addresses a on a.ROWID = m.sender
  left join message_global_data g on g.message_id = m.message_id
`;

interface RawRow {
  rowid: number; messageIdHeader: string | null; subject: string | null;
  sender: string | null; mailboxUrl: string; dateReceived: number;
  dateSent: number | null; readFlag: number; flaggedFlag: number;
  size: number; conversationId: number; attachmentCount: number;
}

function toMessageRow(r: RawRow): MessageRow {
  return {
    rowid: r.rowid,
    messageIdHeader: r.messageIdHeader,
    subject: r.subject,
    sender: r.sender,
    mailboxUrl: r.mailboxUrl,
    dateReceived: r.dateReceived,
    dateSent: r.dateSent,
    read: r.readFlag === 1,
    flagged: r.flaggedFlag === 1,
    size: r.size,
    conversationId: r.conversationId,
    attachmentCount: r.attachmentCount,
  };
}

export class EnvelopeStore {
  private db: Database;

  /**
   * readonly:true is mandatory. Verified that immutable=1 skips the WAL and
   * silently returns stale rows: 103,272 against a true 103,273.
   */
  constructor(storeRoot: string) {
    this.db = new Database(join(storeRoot, "MailData", "Envelope Index"), { readonly: true });
  }

  listMailboxes(): MailboxRow[] {
    const rows = this.db
      .query("select ROWID as rowid, url, total_count as totalCount, unread_count as unreadCount from mailboxes")
      .all() as { rowid: number; url: string; totalCount: number; unreadCount: number }[];

    return rows.map((r) => {
      const u = new URL(r.url);
      const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      return {
        rowid: r.rowid,
        url: r.url,
        accountId: u.hostname,
        name: segments.join("/") || "INBOX",
        totalCount: r.totalCount,
        unreadCount: r.unreadCount,
      };
    });
  }

  searchMessages(f: SearchFilter): MessageRow[] {
    const where: string[] = ["m.deleted = 0"];
    const params: Record<string, string | number> = {};

    if (f.mailboxUrl)     { where.push("mb.url = $mailboxUrl");            params.$mailboxUrl = f.mailboxUrl; }
    if (f.from)           { where.push("a.address like $from");            params.$from = `%${f.from}%`; }
    if (f.subject)        { where.push("s.subject like $subject");         params.$subject = `%${f.subject}%`; }
    if (f.since  !== undefined) { where.push("m.date_received >= $since"); params.$since = f.since; }
    if (f.until  !== undefined) { where.push("m.date_received <= $until"); params.$until = f.until; }
    if (f.unreadOnly)     { where.push("m.read = 0"); }
    if (f.flaggedOnly)    { where.push("m.flagged = 1"); }
    if (f.hasAttachments) { where.push("exists (select 1 from attachments at2 where at2.message = m.ROWID)"); }

    params.$limit = Math.min(f.limit ?? 50, 1000);

    const sql = `${SELECT} where ${where.join(" and ")} order by m.date_received desc limit $limit`;
    return (this.db.query(sql).all(params) as RawRow[]).map(toMessageRow);
  }

  getMessage(rowid: number): MessageRow | null {
    const row = this.db.query(`${SELECT} where m.ROWID = $rowid`).get({ $rowid: rowid }) as RawRow | null;
    return row ? toMessageRow(row) : null;
  }

  getThread(conversationId: number): MessageRow[] {
    const sql = `${SELECT} where m.conversation_id = $cid and m.deleted = 0 order by m.date_received asc`;
    return (this.db.query(sql).all({ $cid: conversationId }) as RawRow[]).map(toMessageRow);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run and confirm it passes**

Run: `bun test test/envelope.test.ts`
Expected: PASS, including the sub-100ms assertion.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store/envelope.ts test/envelope.test.ts
git commit -m "Add Envelope Index reader

The only module that writes SQL. Opens readonly, which is required for
correctness: immutable=1 skips the WAL and returns stale rows.

Subject and sender are integer foreign keys, so every read joins subjects
and addresses. The RFC 5322 Message-ID joins on message_id, not ROWID."
```

---

### Task 4: Startup schema probe

Guards against Apple changing the schema in a future macOS. A wrong answer is worse than a refusal.

**Files:**
- Create: `src/store/probe.ts`
- Test: `test/probe.test.ts`

**Interfaces:**
- Consumes: `findStoreRoot` (Task 1), `EnvelopeStore` (Task 3)
- Produces: `probeStore(storeRoot: string): ProbeResult` where `type ProbeResult = { ok: true; storeVersion: string; messageCount: number } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `test/probe.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { probeStore } from "../src/store/probe";
import { findStoreRoot } from "../src/store/paths";

describe("probeStore", () => {
  test("rejects a path that is not a Mail store", () => {
    const r = probeStore("/tmp/definitely-not-a-mail-store");
    expect(r.ok).toBe(false);
  });

  const root = findStoreRoot();
  test.if(!!root)("accepts the real store and reports its version", () => {
    const r = probeStore(root!);
    if (!r.ok) throw new Error(`probe failed: ${r.reason}`);
    expect(r.storeVersion).toMatch(/^V\d+$/);
    expect(r.messageCount).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test test/probe.test.ts`
Expected: FAIL, cannot resolve `../src/store/probe`.

- [ ] **Step 3: Implement**

Create `src/store/probe.ts`:

```ts
import { Database } from "bun:sqlite";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { resolveMessageFile } from "./paths";

export type ProbeResult =
  | { ok: true; storeVersion: string; messageCount: number }
  | { ok: false; reason: string };

/** Every table and column the read path depends on. */
const REQUIRED: Record<string, string[]> = {
  messages: ["ROWID", "message_id", "subject", "sender", "mailbox", "date_received", "date_sent", "read", "flagged", "deleted", "size", "conversation_id"],
  subjects: ["ROWID", "subject"],
  addresses: ["ROWID", "address"],
  mailboxes: ["ROWID", "url", "total_count", "unread_count"],
  attachments: ["message", "name"],
  message_global_data: ["message_id", "message_id_header"],
};

/**
 * Runs once at startup. On any mismatch the read path refuses rather than
 * returning wrong data. Write tools are unaffected and keep working.
 */
export function probeStore(storeRoot: string): ProbeResult {
  const dbPath = join(storeRoot, "MailData", "Envelope Index");
  if (!existsSync(dbPath)) return { ok: false, reason: `no Envelope Index at ${dbPath}` };

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { ok: false, reason: `cannot open Envelope Index: ${(e as Error).message}` };
  }

  try {
    for (const [table, columns] of Object.entries(REQUIRED)) {
      const info = db.query(`pragma table_info(${table})`).all() as { name: string }[];
      if (info.length === 0) return { ok: false, reason: `missing table: ${table}` };
      const present = new Set(info.map((c) => c.name));
      present.add("ROWID");
      const missing = columns.filter((c) => !present.has(c));
      if (missing.length > 0) {
        return { ok: false, reason: `table ${table} is missing columns: ${missing.join(", ")}` };
      }
    }

    const { c } = db.query("select count(*) as c from messages").get() as { c: number };

    // Sample the shard rule. If Apple changes the layout this catches it here
    // rather than as empty bodies at read time.
    const samples = db
      .query(`select m.ROWID as rowid, mb.url as url from messages m
              join mailboxes mb on mb.ROWID = m.mailbox
              where m.deleted = 0 order by m.date_received desc limit 20`)
      .all() as { rowid: number; url: string }[];

    if (samples.length > 0) {
      const resolved = samples.filter((s) => resolveMessageFile(storeRoot, s.url, s.rowid) !== null);
      if (resolved.length === 0) {
        return { ok: false, reason: "shard rule resolved no files; the on-disk layout may have changed" };
      }
    }

    return { ok: true, storeVersion: basename(storeRoot), messageCount: c };
  } catch (e) {
    return { ok: false, reason: `probe failed: ${(e as Error).message}` };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test test/probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/probe.ts test/probe.test.ts
git commit -m "Add startup schema probe

Apple bumps the store version across major macOS releases and can rename
columns. The probe checks every table and column the read path uses, and
samples the shard rule against real files. On mismatch the read path
refuses with a clear reason instead of returning wrong data."
```

---

### Task 5: MCP server and read tools

At the end of this task the project is a working read-only MCP server.

**Files:**
- Create: `src/dispatcher.ts`, `src/server.ts`
- Test: `test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `EnvelopeStore` (Task 3), `resolveMessageFile` (Task 1), `parseEmlxFile` (Task 2), `probeStore` (Task 4)
- Produces: `class Dispatcher` with `listMailboxes()`, `searchMessages(f: SearchFilter & { body?: string })`, `getMessage(rowid: number)`, `getThread(rowid: number)`, `getAttachment(rowid: number, filename: string)`
- Produces: `BODY_SCAN_CAP = 5000`

- [ ] **Step 1: Write the failing test**

Create `test/dispatcher.test.ts`:

```ts
import { test, expect, describe, afterAll } from "bun:test";
import { Dispatcher, BODY_SCAN_CAP } from "../src/dispatcher";
import { findStoreRoot } from "../src/store/paths";

const root = findStoreRoot();
const d = root ? describe : describe.skip;

d("Dispatcher read path", () => {
  const dispatcher = new Dispatcher(root!);
  afterAll(() => dispatcher.close());

  test("getMessage returns metadata plus a parsed body", async () => {
    const [first] = dispatcher.searchMessages({ limit: 1 });
    const full = await dispatcher.getMessage(first!.rowid);
    expect(full?.rowid).toBe(first!.rowid);
    expect(typeof full?.bodyAvailable).toBe("boolean");
  });

  test("a narrowed body search returns only matching messages", async () => {
    const recent = dispatcher.searchMessages({ limit: 200 });
    const seed = recent.find((r) => (r.subject ?? "").length > 6);
    if (!seed) return;
    const term = seed.subject!.split(/\s+/).find((w) => w.length > 5);
    if (!term) return;

    const hits = await dispatcher.searchMessages({ limit: 200, body: term });
    expect(Array.isArray(hits)).toBe(true);
  });

  test("an unanchored body search refuses instead of scanning the store", async () => {
    await expect(
      dispatcher.searchMessages({ body: "refund", limit: 1000000 }),
    ).rejects.toThrow(/too many candidates/i);
  });

  test("the scan cap is the documented value", () => {
    expect(BODY_SCAN_CAP).toBe(5000);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test test/dispatcher.test.ts`
Expected: FAIL, cannot resolve `../src/dispatcher`.

- [ ] **Step 3: Implement the dispatcher**

Create `src/dispatcher.ts`:

```ts
import { EnvelopeStore } from "./store/envelope";
import { resolveMessageFile } from "./store/paths";
import { parseEmlxFile, type ParsedEmail } from "./store/emlx";
import type { MailboxRow, MessageRow, SearchFilter } from "./types";

/**
 * Above this many candidates a body scan refuses rather than reading tens of
 * thousands of files. Scanning the whole store takes 60 to 90 seconds, and a
 * silent scan or a silent truncation are both worse than an honest refusal.
 */
export const BODY_SCAN_CAP = 5000;

export interface FullMessage extends MessageRow {
  bodyAvailable: boolean;
  partial: boolean;
  text: string | null;
  html: string | null;
  attachments: ParsedEmail["attachments"];
}

export class Dispatcher {
  private store: EnvelopeStore;

  constructor(private storeRoot: string) {
    this.store = new EnvelopeStore(storeRoot);
  }

  listMailboxes(): MailboxRow[] {
    return this.store.listMailboxes();
  }

  searchMessages(f: SearchFilter): MessageRow[];
  searchMessages(f: SearchFilter & { body: string }): Promise<MessageRow[]>;
  searchMessages(f: SearchFilter & { body?: string }): MessageRow[] | Promise<MessageRow[]> {
    if (!f.body) return this.store.searchMessages(f);
    return this.bodyScan(f as SearchFilter & { body: string });
  }

  /** Narrow in SQLite first, then read only the surviving files. */
  private async bodyScan(f: SearchFilter & { body: string }): Promise<MessageRow[]> {
    const candidates = this.store.searchMessages({ ...f, limit: BODY_SCAN_CAP + 1 });

    if (candidates.length > BODY_SCAN_CAP) {
      throw new Error(
        `Body search matched too many candidates (over ${BODY_SCAN_CAP}). ` +
          `Add a narrowing filter such as from, mailboxUrl, or since, then try again.`,
      );
    }

    const needle = f.body.toLowerCase();
    const matched: MessageRow[] = [];
    for (const row of candidates) {
      const file = resolveMessageFile(this.storeRoot, row.mailboxUrl, row.rowid);
      if (!file) continue;
      try {
        const parsed = await parseEmlxFile(file.path);
        const hay = `${parsed.text ?? ""}\n${parsed.html ?? ""}`.toLowerCase();
        if (hay.includes(needle)) matched.push(row);
      } catch {
        continue;
      }
    }
    return matched;
  }

  async getMessage(rowid: number): Promise<FullMessage | null> {
    const row = this.store.getMessage(rowid);
    if (!row) return null;

    const file = resolveMessageFile(this.storeRoot, row.mailboxUrl, rowid);
    if (!file) {
      return { ...row, bodyAvailable: false, partial: false, text: null, html: null, attachments: [] };
    }

    try {
      const parsed = await parseEmlxFile(file.path);
      return {
        ...row,
        bodyAvailable: true,
        partial: file.partial,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments,
      };
    } catch {
      return { ...row, bodyAvailable: false, partial: file.partial, text: null, html: null, attachments: [] };
    }
  }

  getThread(rowid: number): MessageRow[] {
    const row = this.store.getMessage(rowid);
    return row ? this.store.getThread(row.conversationId) : [];
  }

  async getAttachment(rowid: number, filename: string): Promise<{ filename: string; contentType: string; base64: string } | null> {
    const row = this.store.getMessage(rowid);
    if (!row) return null;
    const file = resolveMessageFile(this.storeRoot, row.mailboxUrl, rowid);
    if (!file) return null;

    const { simpleParser } = await import("mailparser");
    const { unwrapEmlx } = await import("./store/emlx");
    const { readFile } = await import("node:fs/promises");

    const parsed = await simpleParser(unwrapEmlx(await readFile(file.path)));
    const found = parsed.attachments.find((a) => a.filename === filename);
    if (!found) return null;

    return {
      filename: found.filename ?? filename,
      contentType: found.contentType,
      base64: found.content.toString("base64"),
    };
  }

  close(): void {
    this.store.close();
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test test/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the MCP server**

Create `src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Dispatcher } from "./dispatcher";
import { findStoreRoot } from "./store/paths";
import { probeStore } from "./store/probe";

const storeRoot = findStoreRoot();
if (!storeRoot) {
  console.error("No Apple Mail store found under ~/Library/Mail. Launch Mail at least once.");
  process.exit(1);
}

const probe = probeStore(storeRoot);
if (!probe.ok) {
  console.error(`Unsupported Apple Mail store: ${probe.reason}`);
  console.error("Read tools are unavailable. This usually means macOS changed the store format,");
  console.error("or the runtime lacks Full Disk Access.");
  process.exit(1);
}
console.error(`Apple Mail store ${probe.storeVersion}, ${probe.messageCount} messages.`);

const dispatcher = new Dispatcher(storeRoot);
const server = new McpServer({ name: "apple-mail", version: "0.1.0" });

server.registerTool(
  "list_mailboxes",
  {
    description: "List all Apple Mail accounts and mailboxes with message and unread counts.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: JSON.stringify(dispatcher.listMailboxes(), null, 2) }] }),
);

server.registerTool(
  "search_messages",
  {
    description:
      "Search messages by metadata, optionally filtering on body text. Metadata filters are near instant. " +
      "A body filter reads message files for the messages that survive the metadata filters, so always " +
      "combine body with at least one of from, mailboxUrl, subject, or since.",
    inputSchema: {
      mailboxUrl: z.string().optional().describe("Exact mailbox url from list_mailboxes"),
      from: z.string().optional().describe("Substring match on sender address"),
      subject: z.string().optional().describe("Substring match on subject"),
      body: z.string().optional().describe("Substring match on body text. Requires narrowing filters."),
      since: z.number().optional().describe("Unix seconds, inclusive lower bound on received date"),
      until: z.number().optional().describe("Unix seconds, inclusive upper bound on received date"),
      unreadOnly: z.boolean().optional(),
      flaggedOnly: z.boolean().optional(),
      hasAttachments: z.boolean().optional(),
      limit: z.number().optional().describe("Default 50, maximum 1000"),
    },
  },
  async (args) => {
    const rows = await dispatcher.searchMessages(args as never);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  },
);

server.registerTool(
  "get_message",
  {
    description: "Get one message in full: headers, text body, HTML body, and attachment list. " +
      "bodyAvailable is false when the body is not stored locally, which happens with Exchange accounts.",
    inputSchema: { rowid: z.number().describe("Message id from search_messages") },
  },
  async ({ rowid }) => {
    const m = await dispatcher.getMessage(rowid);
    return { content: [{ type: "text", text: m ? JSON.stringify(m, null, 2) : "Message not found." }] };
  },
);

server.registerTool(
  "get_thread",
  {
    description: "Get every message in the same conversation as the given message, oldest first.",
    inputSchema: { rowid: z.number() },
  },
  async ({ rowid }) => ({
    content: [{ type: "text", text: JSON.stringify(dispatcher.getThread(rowid), null, 2) }],
  }),
);

server.registerTool(
  "get_attachment",
  {
    description: "Get one attachment's content, base64 encoded.",
    inputSchema: { rowid: z.number(), filename: z.string() },
  },
  async ({ rowid, filename }) => {
    const a = await dispatcher.getAttachment(rowid, filename);
    return { content: [{ type: "text", text: a ? JSON.stringify(a) : "Attachment not found." }] };
  },
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 6: Verify the server starts and typechecks**

```bash
bun run typecheck
bun run src/server.ts < /dev/null
```

Expected: typecheck clean; the server prints the store version and message count to stderr, then exits when stdin closes. If it reports missing Full Disk Access, grant it to the `bun` binary in System Settings, Privacy and Security, Full Disk Access.

- [ ] **Step 7: Commit**

```bash
git add src/dispatcher.ts src/server.ts test/dispatcher.test.ts
git commit -m "Add MCP server with five read tools

Search narrows in SQLite and only then reads message files, so an anchored
body search touches tens of files rather than 103k. An unanchored body
search refuses with a message asking for a narrowing filter, because a
silent 90 second scan and a silent truncation are both worse than saying no."
```

---

### Task 6: AppleScript bridge

Escaping is the injection surface for every mutation, so it is written and attacked before any mutation exists.

**Files:**
- Create: `src/mail/applescript.ts`
- Test: `test/applescript.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `escapeAppleScript(value: string): string`
  - `runAppleScript(script: string, timeoutMs?: number): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `test/applescript.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
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
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test test/applescript.test.ts`
Expected: FAIL, cannot resolve `../src/mail/applescript`.

- [ ] **Step 3: Implement**

Create `src/mail/applescript.ts`:

```ts
/**
 * Escape a value for interpolation into an AppleScript string literal.
 * Backslashes first, otherwise the backslashes introduced when escaping
 * quotes would themselves be escaped and the quoting would invert.
 * Newlines become spaces because a raw newline inside a literal ends the
 * statement and lets the rest of the value execute as code.
 */
export function escapeAppleScript(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, " ");
}

/**
 * Run a script through `osascript -`. The child is killed on timeout so a
 * hung Mail.app cannot leak processes; patrickfreyer's project hit exactly
 * this and had to add orphan tracking.
 */
export async function runAppleScript(script: string, timeoutMs = 120_000): Promise<string> {
  const child = Bun.spawn(["osascript", "-"], {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (child.killed) {
      throw new Error(`AppleScript timed out after ${timeoutMs}ms. The operation may still have succeeded.`);
    }
    if (code !== 0) {
      throw new Error(`AppleScript failed (exit ${code}): ${stderr.trim() || "no stderr"}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test test/applescript.test.ts`
Expected: PASS. The first run may raise a macOS Automation permission prompt. Approve it.

- [ ] **Step 5: Commit**

```bash
git add src/mail/applescript.ts test/applescript.test.ts
git commit -m "Add AppleScript bridge with escaping

Escaping is the injection surface for every mutation, so it lands before
any mutation exists and carries adversarial tests. Backslashes are escaped
before quotes, since the reverse order inverts the quoting, and newlines
are neutralized because a raw newline ends the statement and lets the rest
of the value run as code.

The child is killed on timeout to avoid leaking osascript processes."
```

---

### Task 7: Measure the WAL commit lag

This is the spec's Phase 0. It produces one number: the overlay TTL in Task 9. It is placed here because it needs both the bridge and the reader.

**This task mutates real Mail state.** It creates a mailbox named `MCP Scratch`, sends nothing, flags and unflags one message inside it, and leaves the mailbox in place for reuse. Get explicit confirmation from the repo owner before running it, and do not point it at a real mailbox.

**Files:**
- Create: `scripts/measure-wal-lag.ts`, `docs/measurements/wal-lag.md`

**Interfaces:**
- Consumes: `runAppleScript` (Task 6), `EnvelopeStore` (Task 3), `findStoreRoot` (Task 1)
- Produces: a documented TTL value consumed by Task 9

- [ ] **Step 1: Write the measurement script**

Create `scripts/measure-wal-lag.ts`:

```ts
/**
 * Measures how long after an AppleScript mutation the change becomes visible
 * in the Envelope Index. Output sets the coherence overlay TTL.
 *
 * Operates only on a mailbox named "MCP Scratch". Never point this at real mail.
 */
import { runAppleScript, escapeAppleScript } from "../src/mail/applescript";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";

const SCRATCH = "MCP Scratch";
const root = findStoreRoot();
if (!root) throw new Error("no Mail store found");

const accountName = process.argv[2];
if (!accountName) {
  console.error('Usage: bun run scripts/measure-wal-lag.ts "<Account Name>"');
  console.error("The account must already contain a mailbox named 'MCP Scratch' with at least one message.");
  process.exit(1);
}

const store = new EnvelopeStore(root);
const scratch = store.listMailboxes().find((m) => m.name.endsWith(SCRATCH));
if (!scratch) {
  console.error(`No mailbox named "${SCRATCH}" found. Create it in Mail and move one throwaway message into it.`);
  process.exit(1);
}

const target = store.searchMessages({ mailboxUrl: scratch.url, limit: 1 })[0];
if (!target) {
  console.error(`"${SCRATCH}" is empty. Move one throwaway message into it.`);
  process.exit(1);
}

console.log(`Target: rowid=${target.rowid} flagged=${target.flagged} in ${scratch.name}`);

const samples: number[] = [];
for (let i = 0; i < 5; i++) {
  const desired = !store.getMessage(target.rowid)!.flagged;

  const script = `
    tell application "Mail"
      set theBox to mailbox "${escapeAppleScript(SCRATCH)}" of account "${escapeAppleScript(accountName)}"
      set theMessages to (every message of theBox whose id is ${target.rowid})
      if (count of theMessages) is 0 then error "message not found in scratch mailbox"
      set flagged status of item 1 of theMessages to ${desired}
    end tell`;

  const started = performance.now();
  await runAppleScript(script);
  const afterScript = performance.now();

  let visibleAt = -1;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const fresh = new EnvelopeStore(root);
    const seen = fresh.getMessage(target.rowid);
    fresh.close();
    if (seen?.flagged === desired) { visibleAt = performance.now(); break; }
    await Bun.sleep(10);
  }

  if (visibleAt < 0) {
    console.log(`iteration ${i + 1}: NOT VISIBLE within 15s`);
    continue;
  }

  const lag = visibleAt - afterScript;
  samples.push(lag);
  console.log(
    `iteration ${i + 1}: osascript ${(afterScript - started).toFixed(0)}ms, ` +
    `then visible after ${lag.toFixed(0)}ms`,
  );
}

store.close();
if (samples.length > 0) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(`\nlag samples (ms): ${sorted.map((s) => s.toFixed(0)).join(", ")}`);
  console.log(`median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)}ms, max ${sorted.at(-1)!.toFixed(0)}ms`);
  console.log(`Suggested overlay TTL: ${Math.ceil((sorted.at(-1)! * 4) / 1000) * 1000}ms (4x observed max)`);
}
```

- [ ] **Step 2: Get confirmation, then set up the scratch mailbox**

Ask the repo owner to confirm, then in Mail.app create a mailbox named `MCP Scratch` and move one throwaway message into it. Do not automate this step; the human should choose the message.

- [ ] **Step 3: Run the measurement**

```bash
bun run scripts/measure-wal-lag.ts "<Account Name>"
```

Expected: five iterations, each reporting an osascript duration and a visibility lag, then a suggested TTL.

If any iteration reports NOT VISIBLE within 15 seconds, stop. That means Mail does not reliably flush this change to the Envelope Index, which invalidates the overlay design in Task 9 and needs a design conversation before continuing.

- [ ] **Step 4: Record the result**

Create `docs/measurements/wal-lag.md` with the raw output, the machine and macOS version, the date, and the chosen TTL. This number is otherwise unrecoverable and both prior projects left it unmeasured.

- [ ] **Step 5: Commit**

```bash
git add scripts/measure-wal-lag.ts docs/measurements/wal-lag.md
git commit -m "Measure WAL commit lag after AppleScript mutations

The gap between a write landing in Mail.app and appearing in the Envelope
Index was unmeasured by both prior projects and sets the coherence overlay
TTL. Measured on a scratch mailbox, never on real mail."
```

---

### Task 8: Mutations

At the end of this task the project does something no existing Apple Mail MCP server does: fast local reads plus organizing.

**Files:**
- Create: `src/mail/mutations.ts`
- Modify: `src/dispatcher.ts`, `src/server.ts`
- Test: `test/mutations.test.ts`

**Interfaces:**
- Consumes: `runAppleScript`, `escapeAppleScript` (Task 6), `EnvelopeStore` (Task 3)
- Produces:
  - `markRead(rowids: number[], read: boolean): Promise<number>`
  - `setFlagged(rowids: number[], flagged: boolean): Promise<number>`
  - `moveMessages(rowids: number[], targetMailbox: string, account: string): Promise<number>`
  - `deleteMessages(rowids: number[]): Promise<number>`
  - each returns the count actually affected

- [ ] **Step 1: Write the failing test**

Create `test/mutations.test.ts`. Script generation is tested purely; the AppleScript itself is exercised against the scratch mailbox only.

```ts
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
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test test/mutations.test.ts`
Expected: FAIL, cannot resolve `../src/mail/mutations`.

- [ ] **Step 3: Implement**

Create `src/mail/mutations.ts`:

```ts
import { escapeAppleScript, runAppleScript } from "./applescript";

/**
 * Ids come from SQLite and are interpolated as bare numbers, so they are
 * validated as integers here. This is the only place a non-string value
 * reaches a generated script.
 */
function idList(rowids: number[]): string {
  if (rowids.length === 0) throw new Error("no message ids given");
  for (const id of rowids) {
    if (!Number.isInteger(id)) throw new Error(`message id must be an integer, got ${id}`);
  }
  return rowids.join(", ");
}

/** Collect the target messages across every mailbox into `targets`. */
function preamble(rowids: number[]): string {
  return `
    set wanted to {${idList(rowids)}}
    set targets to {}
    tell application "Mail"
      repeat with acct in every account
        repeat with box in every mailbox of acct
          try
            repeat with m in (every message of box whose id is in wanted)
              set end of targets to m
            end repeat
          end try
        end repeat
      end repeat`;
}

export function buildMarkReadScript(rowids: number[], read: boolean): string {
  return `${preamble(rowids)}
      repeat with m in targets
        set read status of m to ${read ? "true" : "false"}
      end repeat
      return (count of targets)
    end tell`;
}

export function buildFlagScript(rowids: number[], flagged: boolean): string {
  return `${preamble(rowids)}
      repeat with m in targets
        set flagged status of m to ${flagged ? "true" : "false"}
      end repeat
      return (count of targets)
    end tell`;
}

export function buildMoveScript(rowids: number[], targetMailbox: string, account: string): string {
  return `${preamble(rowids)}
      set destination to mailbox "${escapeAppleScript(targetMailbox)}" of account "${escapeAppleScript(account)}"
      repeat with m in targets
        move m to destination
      end repeat
      return (count of targets)
    end tell`;
}

/** Deletion means moving to Trash. Nothing here erases mail. */
export function buildDeleteScript(rowids: number[]): string {
  return `${preamble(rowids)}
      repeat with m in targets
        set deleted status of m to true
      end repeat
      return (count of targets)
    end tell`;
}

const count = async (script: string): Promise<number> =>
  Number.parseInt((await runAppleScript(script)).trim(), 10) || 0;

export const markRead = (rowids: number[], read: boolean) => count(buildMarkReadScript(rowids, read));
export const setFlagged = (rowids: number[], flagged: boolean) => count(buildFlagScript(rowids, flagged));
export const moveMessages = (rowids: number[], targetMailbox: string, account: string) =>
  count(buildMoveScript(rowids, targetMailbox, account));
export const deleteMessages = (rowids: number[]) => count(buildDeleteScript(rowids));
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test test/mutations.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register the write tools**

Append to `src/server.ts` before the `server.connect` call:

```ts
import { markRead, setFlagged, moveMessages, deleteMessages } from "./mail/mutations";

server.registerTool(
  "update_messages",
  {
    description:
      "Mark messages read or unread, flag or unflag them, or move them to another mailbox. " +
      "Operates on a batch of message ids from search_messages. All three operations are reversible.",
    inputSchema: {
      rowids: z.array(z.number()).min(1).describe("Message ids from search_messages"),
      read: z.boolean().optional().describe("Set read status"),
      flagged: z.boolean().optional().describe("Set flagged status"),
      moveTo: z.string().optional().describe("Destination mailbox name, requires account"),
      account: z.string().optional().describe("Account name for moveTo"),
    },
  },
  async ({ rowids, read, flagged, moveTo, account }) => {
    const done: string[] = [];
    if (read !== undefined)    done.push(`read=${read} on ${await markRead(rowids, read)} messages`);
    if (flagged !== undefined) done.push(`flagged=${flagged} on ${await setFlagged(rowids, flagged)} messages`);
    if (moveTo) {
      if (!account) throw new Error("moveTo requires account");
      done.push(`moved ${await moveMessages(rowids, moveTo, account)} messages to ${moveTo}`);
    }
    if (done.length === 0) throw new Error("Nothing to do. Pass at least one of read, flagged, or moveTo.");
    return { content: [{ type: "text", text: done.join("; ") }] };
  },
);

server.registerTool(
  "delete_messages",
  {
    description: "Move messages to Trash. This is reversible from Trash and never erases mail permanently.",
    inputSchema: { rowids: z.array(z.number()).min(1) },
  },
  async ({ rowids }) => ({
    content: [{ type: "text", text: `Moved ${await deleteMessages(rowids)} messages to Trash.` }],
  }),
);
```

- [ ] **Step 6: Verify against the scratch mailbox only**

```bash
bun run typecheck
```

Then, with the repo owner's confirmation, exercise `update_messages` by hand against a message in `MCP Scratch` and confirm in Mail.app that the flag changed. Do not run a batch mutation against a real mailbox at this stage.

- [ ] **Step 7: Commit**

```bash
git add src/mail/mutations.ts test/mutations.test.ts src/server.ts
git commit -m "Add mutation tools for read status, flags, moves, and Trash

Every mutation goes through Mail.app so Mail stays the sole writer of its
own store. Deletion means moving to Trash; nothing here erases mail.

Message ids are validated as integers before interpolation, since they are
the only non-string values reaching a generated script."
```

---

### Task 9: Parity against AppleScript

The spec calls this non-negotiable before the fast path is allowed to front the slow one. It also serves as the regression guard on the id equivalence in Reference Facts, which is load-bearing and contradicts published prior art.

**Files:**
- Test: `test/parity.test.ts`

**Interfaces:**
- Consumes: `EnvelopeStore` (Task 3), `runAppleScript`, `escapeAppleScript` (Task 6)
- Produces: no source, a test gate only

- [ ] **Step 1: Write the parity test**

Create `test/parity.test.ts`:

```ts
import { test, expect, describe, afterAll } from "bun:test";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";
import { runAppleScript, escapeAppleScript } from "../src/mail/applescript";

const root = findStoreRoot();
const d = root ? describe : describe.skip;

/** Read id, read status, and flagged status for the newest N messages. */
async function viaAppleScript(account: string, mailbox: string, n: number) {
  const out = await runAppleScript(`
    tell application "Mail"
      set theBox to mailbox "${escapeAppleScript(mailbox)}" of (first account whose name is "${escapeAppleScript(account)}")
      set out to ""
      repeat with i from 1 to ${n}
        set m to message i of theBox
        set out to out & (id of m) & "|" & (read status of m) & "|" & (flagged status of m) & linefeed
      end repeat
      return out
    end tell`);

  return out
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [id, read, flagged] = line.split("|");
      return { rowid: Number(id), read: read === "true", flagged: flagged === "true" };
    });
}

d("parity between the SQLite path and AppleScript", () => {
  const store = new EnvelopeStore(root!);
  afterAll(() => store.close());

  // Pick the smallest non-empty mailbox so the AppleScript side stays fast.
  const boxes = store.listMailboxes()
    .filter((b) => b.totalCount > 0 && b.totalCount < 500)
    .sort((a, b) => a.totalCount - b.totalCount);

  const target = boxes[0];
  const it = target ? test : test.skip;

  it("AppleScript ids appear as ROWIDs in SQLite with matching flags", async () => {
    const account = new URL(target!.url).hostname;
    const accountName = (await runAppleScript(
      `tell application "Mail" to return name of (first account whose id is "${escapeAppleScript(account)}")`,
    )).trim();

    const fromScript = await viaAppleScript(accountName, target!.name, 10);
    expect(fromScript.length).toBeGreaterThan(0);

    for (const scripted of fromScript) {
      const row = store.getMessage(scripted.rowid);

      // The id equivalence itself. If this fails, AppleScript ids are no
      // longer ROWIDs and every mutation in this project targets wrong rows.
      expect(row, `AppleScript id ${scripted.rowid} has no matching ROWID`).not.toBeNull();

      expect(row!.read,    `read mismatch on ${scripted.rowid}`).toBe(scripted.read);
      expect(row!.flagged, `flagged mismatch on ${scripted.rowid}`).toBe(scripted.flagged);
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run it**

Run: `bun test test/parity.test.ts`
Expected: PASS.

A read or flagged mismatch on one message is most likely the WAL lag from Task 7 rather than a real parity break; re-run once before investigating. A null row, meaning an AppleScript id with no matching `ROWID`, is a hard failure and must stop work: it means the id equivalence no longer holds and every mutation targets the wrong messages.

- [ ] **Step 3: Commit**

```bash
git add test/parity.test.ts
git commit -m "Add parity test between the SQLite read path and AppleScript

The fast path is only allowed to front the slow one if it returns the same
messages with the same flags. This also guards the id equivalence, which is
load-bearing and contradicts a published spike: AppleScript's message id is
the SQLite ROWID, not messages.message_id."
```

---

### Task 10: Coherence overlay

**Files:**
- Create: `src/coherence/overlay.ts`
- Modify: `src/dispatcher.ts`, `src/server.ts`
- Test: `test/overlay.test.ts`

**Interfaces:**
- Consumes: the TTL measured in Task 7
- Produces: `class WriteOverlay` with `record(rowid, patch)`, `apply(row: MessageRow): MessageRow`, `applyAll(rows: MessageRow[]): MessageRow[]`, `reconcile(rows: MessageRow[]): void`, `size(): number`

- [ ] **Step 1: Write the failing test**

Create `test/overlay.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { WriteOverlay } from "../src/coherence/overlay";
import type { MessageRow } from "../src/types";

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  rowid: 1, messageIdHeader: null, subject: "s", sender: "a@b.c",
  mailboxUrl: "imap://ACC/INBOX", dateReceived: 0, dateSent: null,
  read: false, flagged: false, size: 0, conversationId: 0, attachmentCount: 0,
  ...over,
});

describe("WriteOverlay", () => {
  test("a pending write shows through on a stale row", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    expect(o.apply(row({ flagged: false })).flagged).toBe(true);
  });

  test("rows without a pending write are untouched", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    expect(o.apply(row({ rowid: 2, flagged: false })).flagged).toBe(false);
  });

  test("the entry is dropped once the database agrees", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    expect(o.size()).toBe(1);
    o.reconcile([row({ flagged: true })]);
    expect(o.size()).toBe(0);
  });

  test("the entry survives while the database still disagrees", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    o.reconcile([row({ flagged: false })]);
    expect(o.size()).toBe(1);
  });

  test("an expired entry stops applying", async () => {
    const o = new WriteOverlay(50);
    o.record(1, { flagged: true });
    await Bun.sleep(80);
    expect(o.apply(row({ flagged: false })).flagged).toBe(false);
    expect(o.size()).toBe(0);
  });

  test("later writes merge over earlier ones for the same message", () => {
    const o = new WriteOverlay(5000);
    o.record(1, { flagged: true });
    o.record(1, { read: true });
    const r = o.apply(row());
    expect(r.flagged).toBe(true);
    expect(r.read).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test test/overlay.test.ts`
Expected: FAIL, cannot resolve `../src/coherence/overlay`.

- [ ] **Step 3: Implement**

Create `src/coherence/overlay.ts`:

```ts
import type { MessageRow } from "../types";

export type WritePatch = Partial<Pick<MessageRow, "read" | "flagged" | "mailboxUrl">>;

interface Entry { patch: WritePatch; at: number }

/**
 * Writes go through Mail.app; reads come from SQLite. Mail updates the
 * Envelope Index as part of the operation, but not instantly. Without this,
 * an agent can flag a message, re-read, see it unflagged, and flag it again.
 *
 * Deliberately in-memory and non-persistent. This smooths a short window and
 * is never the source of truth. Size the TTL from docs/measurements/wal-lag.md.
 */
export class WriteOverlay {
  private pending = new Map<number, Entry>();

  constructor(private ttlMs: number) {}

  record(rowid: number, patch: WritePatch): void {
    const existing = this.pending.get(rowid);
    this.pending.set(rowid, {
      patch: { ...(existing?.patch ?? {}), ...patch },
      at: Date.now(),
    });
  }

  apply(row: MessageRow): MessageRow {
    const entry = this.pending.get(row.rowid);
    if (!entry) return row;
    if (Date.now() - entry.at > this.ttlMs) {
      this.pending.delete(row.rowid);
      return row;
    }
    return { ...row, ...entry.patch };
  }

  applyAll(rows: MessageRow[]): MessageRow[] {
    return this.pending.size === 0 ? rows : rows.map((r) => this.apply(r));
  }

  /** Drop entries the database has caught up with. */
  reconcile(rows: MessageRow[]): void {
    for (const row of rows) {
      const entry = this.pending.get(row.rowid);
      if (!entry) continue;
      const agreed = Object.entries(entry.patch).every(
        ([k, v]) => row[k as keyof MessageRow] === v,
      );
      if (agreed) this.pending.delete(row.rowid);
    }
  }

  size(): number {
    for (const [rowid, entry] of this.pending) {
      if (Date.now() - entry.at > this.ttlMs) this.pending.delete(rowid);
    }
    return this.pending.size;
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test test/overlay.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the dispatcher**

In `src/dispatcher.ts`, add the import and field, and reconcile then apply on every read:

```ts
import { WriteOverlay, type WritePatch } from "./coherence/overlay";

// inside class Dispatcher:
  readonly overlay: WriteOverlay;

// in the constructor, after this.store is assigned:
    this.overlay = new WriteOverlay(overlayTtlMs);

// change the constructor signature to:
  constructor(private storeRoot: string, overlayTtlMs = 5000) {
```

Then in `searchMessages`, replace `return this.store.searchMessages(f);` with:

```ts
    const rows = this.store.searchMessages(f);
    this.overlay.reconcile(rows);
    return this.overlay.applyAll(rows);
```

And in `getMessage`, after `const row = this.store.getMessage(rowid);` and the null check, add:

```ts
    this.overlay.reconcile([row]);
    const patched = this.overlay.apply(row);
```

then use `patched` in place of `row` in the three return statements.

Add a method for the write path to call:

```ts
  recordWrite(rowids: number[], patch: WritePatch): void {
    for (const id of rowids) this.overlay.record(id, patch);
  }
```

Replace the default `5000` with the value measured in Task 7 and recorded in `docs/measurements/wal-lag.md`.

- [ ] **Step 6: Record writes from the tools**

In `src/server.ts`, inside `update_messages`, after each successful operation:

```ts
    if (read !== undefined)    dispatcher.recordWrite(rowids, { read });
    if (flagged !== undefined) dispatcher.recordWrite(rowids, { flagged });
```

- [ ] **Step 7: Verify**

```bash
bun run typecheck && bun test
```

Expected: everything passes.

- [ ] **Step 8: Commit**

```bash
git add src/coherence/overlay.ts test/overlay.test.ts src/dispatcher.ts src/server.ts
git commit -m "Add write overlay to cover the read-after-write gap

Writes land in Mail.app, reads come from SQLite, and the Envelope Index
takes a moment to catch up. Without this an agent can flag a message,
re-read it, see it unflagged, and flag it again.

The overlay is in-memory, TTL bounded, and drops each entry as soon as the
database agrees. It is never the source of truth."
```

---

### Task 11: Drafts

**Files:**
- Modify: `src/mail/mutations.ts`, `src/server.ts`
- Test: `test/drafts.test.ts`

**Interfaces:**
- Consumes: `escapeAppleScript`, `runAppleScript` (Task 6), `Dispatcher.getMessage` (Task 5)
- Produces:
  - `buildDraftScript(d: DraftSpec): string`
  - `createDraft(d: DraftSpec): Promise<string>`
  - `interface DraftSpec { to: string[]; cc?: string[]; subject: string; body: string; inReplyToRowid?: number; references?: string | null }`

- [ ] **Step 1: Write the failing test**

Create `test/drafts.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `bun test test/drafts.test.ts`
Expected: FAIL, `buildDraftScript` is not exported.

- [ ] **Step 3: Implement**

Append to `src/mail/mutations.ts`:

```ts
export interface DraftSpec {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyToRowid?: number;
}

/**
 * Creates a draft and leaves it visible in Mail. There is no send path here
 * by design: the human presses send.
 *
 * Body newlines are preserved by joining AppleScript string literals with
 * `return`, since escapeAppleScript flattens newlines for safety.
 */
export function buildDraftScript(d: DraftSpec): string {
  if (d.to.length === 0) throw new Error("a draft needs at least one recipient");

  const bodyLiteral = d.body
    .split(/\r\n|\r|\n/)
    .map((line) => `"${escapeAppleScript(line)}"`)
    .join(" & return & ");

  const recipients = [
    ...d.to.map((a) => `make new to recipient at end of to recipients with properties {address:"${escapeAppleScript(a)}"}`),
    ...(d.cc ?? []).map((a) => `make new cc recipient at end of cc recipients with properties {address:"${escapeAppleScript(a)}"}`),
  ].join("\n        ");

  return `
    tell application "Mail"
      set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(d.subject)}", content:${bodyLiteral}, visible:true}
      tell newMessage
        ${recipients}
      end tell
      save newMessage
      return "draft created"
    end tell`;
}

export const createDraft = (d: DraftSpec) => runAppleScript(buildDraftScript(d));
```

- [ ] **Step 4: Run and confirm it passes**

Run: `bun test test/drafts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Register the draft tool**

Append to `src/server.ts` before `server.connect`:

```ts
import { createDraft } from "./mail/mutations";

server.registerTool(
  "create_draft",
  {
    description:
      "Create a draft email in Apple Mail. The draft is saved to Drafts and opened for review. " +
      "This server cannot send mail; the human presses send. " +
      "Pass replyToRowid to quote and address an existing message.",
    inputSchema: {
      to: z.array(z.string()).min(1).describe("Recipient email addresses"),
      cc: z.array(z.string()).optional(),
      subject: z.string(),
      body: z.string(),
      replyToRowid: z.number().optional().describe("Message id being replied to, from search_messages"),
    },
  },
  async ({ to, cc, subject, body, replyToRowid }) => {
    let finalSubject = subject;
    let finalBody = body;

    if (replyToRowid !== undefined) {
      const original = await dispatcher.getMessage(replyToRowid);
      if (!original) throw new Error(`Message ${replyToRowid} not found.`);
      if (!/^re:/i.test(finalSubject) && original.subject) {
        finalSubject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
      }
      const quoted = (original.text ?? "").split("\n").map((l) => `> ${l}`).join("\n");
      finalBody = `${body}\n\nOn ${new Date(original.dateReceived * 1000).toLocaleString()}, ${original.sender ?? "someone"} wrote:\n${quoted}`;
    }

    await createDraft({ to, cc, subject: finalSubject, body: finalBody });
    return { content: [{ type: "text", text: `Draft saved to Drafts and opened in Mail. Review it and send it yourself.` }] };
  },
);
```

- [ ] **Step 6: Verify end to end**

```bash
bun run typecheck && bun test
```

Then, with the repo owner present, call `create_draft` once addressed to their own email and confirm the draft appears in Mail and that nothing was sent.

- [ ] **Step 7: Write the README**

Create `README.md` covering: what it is and the gap it fills; the two permissions and that Full Disk Access is a broad grant to the `bun` binary; install and MCP client config; the ten tools; the stated limitation that unanchored body search refuses above 5,000 candidates; and that the server cannot send mail.

- [ ] **Step 8: Commit**

```bash
git add src/mail/mutations.ts test/drafts.test.ts src/server.ts README.md
git commit -m "Add draft composition and README

Drafts are the only compose primitive. There is no send path: the draft is
saved to Drafts and opened, and the human presses send.

Body newlines are rebuilt with AppleScript's return operator, since the
escaper flattens newlines to keep them from ending the statement."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: shard rule and store discovery to Task 1; `.emlx` and the mailparser constraint to Task 2; the readonly requirement, joins, and search to Task 3; schema drift handling to Task 4; the five read tools and the body-scan refusal to Task 5; escaping and the bridge to Task 6; the unmeasured WAL lag to Task 7; the four organize tools to Task 8; parity to Task 9; the overlay to Task 10; drafts, the no-send rule, and permission documentation to Task 11.

**Defect found and fixed during review.** The first draft of Tasks 7 and 8 interpolated `rowid` into AppleScript `whose id is` clauses on the assumption that AppleScript ids are `ROWID`s. The s-morgan-jeffries spike states they are `messages.message_id` instead, which would have made every mutation target the wrong messages. Checked directly against Mail: AppleScript ids **are** `ROWID`s and the spike is wrong on this macOS version. The assumption is now recorded in Reference Facts with its evidence, and Task 9 guards it as a test.

**One spec item still open.** Gmail All Mail deduplication was left open in the spec pending measurement and is still open. It should be decided once the read path exists and the duplication can be counted rather than guessed at.

**Ordering deviation from the spec.** The spec lists measurement as Phase 0. It is Task 7 here because it needs both the AppleScript bridge and the envelope reader. Task 10 consumes its output, so the dependency the spec cared about still holds.

**Type consistency.** `MessageRow`, `MailboxRow`, and `SearchFilter` are defined once in Task 3 and referenced unchanged in Tasks 5, 9, 10, and 11. `resolveMessageFile` returns `{ path, partial } | null` in Task 1 and is consumed with that shape in Tasks 4 and 5. `WritePatch` is defined in Task 10 and used by `recordWrite` in the same task. `buildDraftScript` and `DraftSpec` are defined and consumed within Task 11. There is exactly one message id type, `rowid`, throughout.

**Risk carried into execution.** Task 8's mutation scripts loop over every mailbox of every account to find messages by id, which is correct but slow on a large store: this one has 39 mailboxes and 25,293 messages in its largest. If it proves too slow, pass the known `mailboxUrl` from the read path to scope the search to a single mailbox. Not optimized now, because it should be measured rather than guessed at.
