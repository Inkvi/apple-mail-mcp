import type { MessageRow } from "../types";

// Only read and flagged are overlaid. Moves and deletes deliberately are
// not: masking their visibility window would need a mailbox-name-to-url
// lookup, and the measured post-write lag of 0 to 1 ms
// (docs/measurements/wal-lag.md) makes that window too small to be worth it.
export type WritePatch = Partial<Pick<MessageRow, "read" | "flagged">>;

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
