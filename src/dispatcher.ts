import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import { clampLimit, EnvelopeStore } from "./store/envelope";
import { resolveMessageFile } from "./store/paths";
import { parseEmlxFile, unwrapEmlx, type ParsedEmail } from "./store/emlx";
import { BODY_SCAN_CAP } from "./limits";
import { WriteOverlay, type WritePatch } from "./coherence/overlay";
import type { MailboxRow, MessageRow, SearchFilter } from "./types";

export { BODY_SCAN_CAP };

export interface FullMessage extends MessageRow {
  bodyAvailable: boolean;
  partial: boolean;
  text: string | null;
  html: string | null;
  attachments: ParsedEmail["attachments"];
}

export class Dispatcher {
  private store: EnvelopeStore;
  readonly overlay: WriteOverlay;

  // Default TTL sized from docs/measurements/wal-lag.md: measured post-write
  // lag is 0 to 1 ms and the osascript round trip is about 200 ms, so 2000 ms
  // covers everything measured roughly tenfold. Re-measure before changing.
  constructor(private storeRoot: string, overlayTtlMs = 2000) {
    this.store = new EnvelopeStore(storeRoot);
    this.overlay = new WriteOverlay(overlayTtlMs);
  }

  listMailboxes(): MailboxRow[] {
    return this.store.listMailboxes();
  }

  /** Metadata-only search. Runs entirely in SQLite, near instant. */
  searchMessages(f: SearchFilter): MessageRow[] {
    const rows = this.store.searchMessages(f);
    this.overlay.reconcile(rows);
    return this.overlay.applyAll(rows);
  }

  /**
   * Narrow in SQLite first, then read only the surviving files. The candidate
   * pool is bounded by BODY_SCAN_CAP alone, never by the caller's limit, so a
   * body search covers every metadata match or refuses. The caller's limit
   * only caps how many matches come back. Fetching one row past the cap makes
   * overflow detectable.
   */
  async searchMessagesWithBody(f: SearchFilter & { body: string }): Promise<MessageRow[]> {
    const candidates = this.store.searchMessages(f, BODY_SCAN_CAP + 1);

    if (candidates.length > BODY_SCAN_CAP) {
      throw new Error(
        `Body search matched too many candidates (over ${BODY_SCAN_CAP}). ` +
          `Add a narrowing filter such as from, mailboxUrl, or since, then try again.`,
      );
    }

    const maxResults = clampLimit(f.limit);
    const needle = f.body.toLowerCase();
    const matched: MessageRow[] = [];
    for (const row of candidates) {
      const file = resolveMessageFile(this.storeRoot, row.mailboxUrl, row.rowid);
      if (!file) continue;
      try {
        const parsed = await parseEmlxFile(file.path);
        const hay = `${parsed.text ?? ""}\n${parsed.html ?? ""}`.toLowerCase();
        if (hay.includes(needle)) {
          matched.push(row);
          // Candidates are newest first, so stopping at the limit returns the
          // same rows as scanning everything and slicing.
          if (matched.length >= maxResults) break;
        }
      } catch {
        continue;
      }
    }
    this.overlay.reconcile(matched);
    return this.overlay.applyAll(matched);
  }

  async getMessage(rowid: number): Promise<FullMessage | null> {
    const row = this.store.getMessage(rowid);
    if (!row) return null;
    this.overlay.reconcile([row]);
    const patched = this.overlay.apply(row);

    const file = resolveMessageFile(this.storeRoot, row.mailboxUrl, rowid);
    if (!file) {
      return { ...patched, bodyAvailable: false, partial: false, text: null, html: null, attachments: [] };
    }

    try {
      const parsed = await parseEmlxFile(file.path);
      return {
        ...patched,
        bodyAvailable: true,
        partial: file.partial,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments,
      };
    } catch {
      return { ...patched, bodyAvailable: false, partial: file.partial, text: null, html: null, attachments: [] };
    }
  }

  getThread(rowid: number): MessageRow[] {
    const row = this.store.getMessage(rowid);
    if (!row) return [];
    const rows = this.store.getThread(row.conversationId);
    this.overlay.reconcile(rows);
    return this.overlay.applyAll(rows);
  }

  recordWrite(rowids: number[], patch: WritePatch): void {
    for (const id of rowids) this.overlay.record(id, patch);
  }

  async getAttachment(rowid: number, filename: string): Promise<{ filename: string; contentType: string; base64: string } | null> {
    const row = this.store.getMessage(rowid);
    if (!row) return null;
    const file = resolveMessageFile(this.storeRoot, row.mailboxUrl, rowid);
    if (!file) return null;

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
