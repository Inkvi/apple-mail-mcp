# apple-mail-mcp

An MCP server for Apple Mail that reads directly from Mail's on-disk SQLite
store and writes through Mail.app via AppleScript.

## Why this exists

Existing Apple Mail MCP servers pick one of two designs. Some read Mail's
SQLite database and are fast but read-only. Others drive AppleScript for
everything and can write, but every query pays AppleScript's cost: listing or
searching mail this way takes seconds where a SQLite query takes a
millisecond.

This server does both jobs with the right tool for each:

- **Reads** come from Mail's Envelope Index (SQLite, opened read-only) and
  from the `.emlx` message files on disk. Metadata queries return in well
  under a millisecond.
- **Writes** go through Mail.app via AppleScript, so Mail stays the owner of
  its own store. This server never writes to Mail's database or files.

A small coherence overlay bridges the two paths, so a read issued right after
a write reflects the write even before Mail commits it to SQLite. In
practice that window is tiny: measured on this store, changes are visible in
SQLite within 0 to 1 ms of the AppleScript call returning.

## This server cannot send mail

By design there is no send capability. The only compose primitive is
`create_draft`, which saves a draft to the Drafts mailbox and opens it in
Mail for review. A human presses send. There is no hidden flag or parameter
that changes this.

## Requirements

- macOS with Mail.app set up (the store format probed at startup is Mail V10)
- [Bun](https://bun.sh) 1.3.14 or newer

## Permissions, stated plainly

The server needs two macOS grants:

1. **Automation for Mail.** The first AppleScript write triggers a prompt
   asking to allow your MCP client (or terminal) to control Mail. This gates
   all write tools.
2. **Full Disk Access for the `bun` binary.** Mail's store under
   `~/Library/Mail` is protected, so the process reading it needs Full Disk
   Access. Be clear about what this means: Full Disk Access is a broad
   grant. It lets `bun`, and therefore anything you run with `bun`, read
   protected files across your account, not just Mail. Grant it in System
   Settings under Privacy & Security, Full Disk Access, by adding the `bun`
   binary (find it with `which bun`). If you are not comfortable with that
   trade, do not install this server.

## Install

```bash
git clone <this repository>
cd apple-mail-mcp
bun install
```

Verify it starts (it prints the detected store and message count to stderr):

```bash
bun run src/server.ts
```

## MCP client configuration

For Claude Desktop or any client that takes the standard JSON config:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/apple-mail-mcp/src/server.ts"]
    }
  }
}
```

For Claude Code:

```bash
claude mcp add apple-mail -- bun run /absolute/path/to/apple-mail-mcp/src/server.ts
```

## Tools

Messages are identified by one id everywhere: `rowid`, as returned by
`search_messages`.

### Read tools (SQLite and `.emlx`, no AppleScript involved)

| Tool | What it does |
|---|---|
| `list_mailboxes` | All accounts and mailboxes with message and unread counts |
| `search_messages` | Search by mailbox, sender, subject, date range, read/flagged state, attachments, and optionally body text |
| `get_message` | One full message: headers, text body, HTML body, attachment list |
| `get_thread` | Every message in the same conversation, oldest first |
| `get_attachment` | One attachment's content, base64 encoded |

### Write tools (AppleScript through Mail.app)

| Tool | What it does |
|---|---|
| `update_messages` | Mark read or unread, flag or unflag, move to another mailbox, in batch |
| `delete_messages` | Move messages to Trash |
| `create_draft` | Create a draft, optionally quoting a message being replied to. Saved to Drafts and opened; never sent |

Every write is reversible: read and flag states toggle back, moves can be
moved back, and delete means moving to Trash, never erasing. Nothing in this
server can permanently destroy or send mail.

## Known limitation: body search is capped

Body text is not in Mail's SQLite index, so a body search first narrows
candidates by metadata, then reads each surviving `.emlx` file. If the
metadata filters leave more than 5,000 candidates, the search refuses and
asks you to add a narrowing filter (`from`, `mailboxUrl`, `subject`, or
`since`) instead of scanning.

Why refuse rather than try harder: scanning the whole store takes 60 to 90
seconds, and silently scanning that long or silently truncating the
candidate set are both worse than an honest refusal that tells you how to
narrow the query.

Also worth knowing: message bodies are only searchable and readable when
they are stored locally. Accounts that do not keep full local copies (some
Exchange setups) report `bodyAvailable: false` for affected messages.

## Measured performance

Numbers from this repository's own measurements on a real store of 103,273
messages (416 MB Envelope Index):

- Metadata queries: 0.3 to 0.5 ms warm for a 200-row joined query
- `rowid` to `.emlx` file path resolution: about 0.14 ms per message
- Write visibility: after an AppleScript mutation returns (the call itself
  takes roughly 180 to 200 ms), the change is visible in SQLite within 0 to
  1 ms

Raw data and methodology are in `docs/measurements/wal-lag.md` and the spec
under `docs/superpowers/specs/`.

## Development

```bash
bun test          # full suite
bun run typecheck # tsc --noEmit
```
