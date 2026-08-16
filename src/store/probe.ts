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
  recipients: ["message", "address"],
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
