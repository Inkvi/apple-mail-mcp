import { readFile } from "node:fs/promises";
import { simpleParser } from "mailparser";
import { clampLimit, EnvelopeStore } from "./store/envelope";
import { resolveMessageFile } from "./store/paths";
import { parseEmlxFile, unwrapEmlx, type ParsedEmail } from "./store/emlx";
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

  /** Metadata-only search. Runs entirely in SQLite, near instant. */
  searchMessages(f: SearchFilter): MessageRow[] {
    return this.store.searchMessages(f);
  }

  /**
   * Narrow in SQLite first, then read only the surviving files. The caller's
   * limit bounds the candidate pool; when the pool would exceed BODY_SCAN_CAP
   * the scan refuses rather than reading tens of thousands of files.
   */
  async searchMessagesWithBody(f: SearchFilter & { body: string }): Promise<MessageRow[]> {
    const candidateLimit = clampLimit(f.limit, BODY_SCAN_CAP + 1);
    const candidates = this.store.searchMessages(f, candidateLimit);

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
