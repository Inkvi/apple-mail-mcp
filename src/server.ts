import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Dispatcher, DegradedDispatcher, type MailDispatcher } from "./dispatcher";
import { markRead, setFlagged, moveMessages, deleteMessages, createDraft, updateDraft, deleteDraft } from "./mail/mutations";
import { findStoreRoot } from "./store/paths";
import { probeStore, type ProbeResult } from "./store/probe";

// A failed probe degrades the server instead of killing it: the AppleScript
// write path never touches the store, so write tools keep working while read
// tools return the probe's reason.
const storeRoot = findStoreRoot();
const probe: ProbeResult = storeRoot
  ? probeStore(storeRoot)
  : { ok: false, reason: "no Apple Mail store found under ~/Library/Mail; launch Mail at least once" };

let dispatcher: MailDispatcher;
if (probe.ok) {
  console.error(`Apple Mail store ${probe.storeVersion}, ${probe.messageCount} messages.`);
  dispatcher = new Dispatcher(storeRoot!);
} else {
  console.error(`Unsupported Apple Mail store: ${probe.reason}`);
  console.error("Read tools will return this error. This usually means macOS changed the store");
  console.error("format, or the runtime lacks Full Disk Access. Write tools keep working.");
  dispatcher = new DegradedDispatcher(probe.reason);
}
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
    const rows = args.body
      ? await dispatcher.searchMessagesWithBody({ ...args, body: args.body })
      : dispatcher.searchMessages(args);
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
    if (read !== undefined) {
      done.push(`read=${read} on ${await markRead(rowids, read)} messages`);
      dispatcher.recordWrite(rowids, { read });
    }
    if (flagged !== undefined) {
      done.push(`flagged=${flagged} on ${await setFlagged(rowids, flagged)} messages`);
      dispatcher.recordWrite(rowids, { flagged });
    }
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

server.registerTool(
  "update_draft",
  {
    description:
      "Update a draft by replacing it: Mail forbids editing a saved draft in place, so the old draft " +
      "is moved to Trash and a new draft is created. The draft's id therefore changes; find the " +
      "replacement via search_messages. Omit subject to keep the original draft's subject, which keeps " +
      "a reply threaded by subject. This server cannot send mail; the human presses send.",
    inputSchema: {
      rowid: z.number().describe("Draft id from search_messages"),
      to: z.array(z.string()).min(1).describe("Recipient email addresses for the replacement"),
      cc: z.array(z.string()).optional(),
      subject: z.string().optional().describe("Omit to keep the original draft's subject"),
      body: z.string().describe("Full body of the replacement draft"),
    },
  },
  async ({ rowid, to, cc, subject, body }) => {
    const original = await dispatcher.getMessage(rowid);
    if (!original) throw new Error(`Message ${rowid} not found.`);
    const replaced = await updateDraft(rowid, { to, cc, subject: subject ?? original.subject ?? "", body });
    if (replaced === 0) throw new Error(`Message ${rowid} is not in Drafts. Nothing was created or deleted.`);
    return {
      content: [{
        type: "text",
        text: "Draft replaced: the old draft moved to Trash and the new draft was saved to Drafts and opened. " +
          "Its id changed. Review it and send it yourself.",
      }],
    };
  },
);

server.registerTool(
  "delete_draft",
  {
    description:
      "Move a draft to Trash. Only searches the Drafts mailbox, so it cannot touch ordinary mail. " +
      "Reversible from Trash.",
    inputSchema: { rowid: z.number().describe("Draft id from search_messages") },
  },
  async ({ rowid }) => {
    const n = await deleteDraft(rowid);
    if (n === 0) throw new Error(`No draft with id ${rowid} found in Drafts.`);
    return { content: [{ type: "text", text: `Moved draft ${rowid} to Trash.` }] };
  },
);

await server.connect(new StdioServerTransport());
