import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Dispatcher } from "./dispatcher";
import { markRead, setFlagged, moveMessages, deleteMessages } from "./mail/mutations";
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

await server.connect(new StdioServerTransport());
