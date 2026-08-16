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

/**
 * Total clamp for the query limit: every possible input maps to an integer
 * in [1, 1000]. Non-finite values (NaN, Infinity) and undefined fall back to
 * the default of 50. SQLite treats LIMIT -1 as unbounded and rejects REAL
 * bindings, so this must hold for hostile input; SearchFilter is fed straight
 * from MCP tool input and this module is the safety boundary.
 */
export function clampLimit(limit: number | undefined, max = 1000): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}

/**
 * Ceiling for internal callers that need a candidate pool larger than the
 * MCP-facing cap of 1000. Must stay at least BODY_SCAN_CAP + 1 from the
 * dispatcher, or body scan overflow detection breaks.
 */
export const INTERNAL_LIMIT_MAX = 5001;

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

  /**
   * internalLimit raises the ceiling for internal callers such as the
   * dispatcher's body scan. It is clamped too, to INTERNAL_LIMIT_MAX, so no
   * caller can produce an unbounded query or a non-integer binding.
   */
  searchMessages(f: SearchFilter, internalLimit?: number): MessageRow[] {
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

    params.$limit = internalLimit !== undefined
      ? clampLimit(internalLimit, INTERNAL_LIMIT_MAX)
      : clampLimit(f.limit);

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
