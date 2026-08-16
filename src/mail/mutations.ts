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

export interface DraftSpec {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

/**
 * Body newlines are preserved by joining AppleScript string literals with
 * `return`, since escapeAppleScript flattens newlines for safety. An empty
 * body splits to [""], so this always yields a valid string expression.
 */
function draftContentLiteral(body: string): string {
  return body
    .split(/\r\n|\r|\n/)
    .map((line) => `"${escapeAppleScript(line)}"`)
    .join(" & return & ");
}

function draftRecipientLines(d: DraftSpec): string {
  if (d.to.length === 0) throw new Error("a draft needs at least one recipient");
  return [
    ...d.to.map((a) => `make new to recipient at end of to recipients with properties {address:"${escapeAppleScript(a)}"}`),
    ...(d.cc ?? []).map((a) => `make new cc recipient at end of cc recipients with properties {address:"${escapeAppleScript(a)}"}`),
  ].join("\n        ");
}

/** The statements that create and save one visible draft. Never a send. */
function makeDraftStatements(d: DraftSpec): string {
  const recipients = draftRecipientLines(d);
  return `set newMessage to make new outgoing message with properties {subject:"${escapeAppleScript(d.subject)}", content:${draftContentLiteral(d.body)}, visible:true}
      tell newMessage
        ${recipients}
      end tell
      save newMessage`;
}

/**
 * Creates a draft and leaves it visible in Mail. There is no send path here
 * by design: the human presses send.
 */
export function buildDraftScript(d: DraftSpec): string {
  return `
    tell application "Mail"
      ${makeDraftStatements(d)}
      return "draft created"
    end tell`;
}

function draftRowid(rowid: number): number {
  if (!Number.isInteger(rowid)) throw new Error(`draft id must be an integer, got ${rowid}`);
  return rowid;
}

/**
 * Drafts are removed with the `delete` command, never by setting
 * `deleted status` the way buildDeleteScript does for ordinary mail: on a
 * saved draft, `set deleted status to true` fails with error -609
 * (connection invalid) while `delete` moves it to Trash. Observed live on
 * this machine, 2026-08-15. Do not unify this with the message path.
 *
 * Only the Drafts mailbox is searched, so this can never touch ordinary
 * mail.
 */
export function buildDeleteDraftScript(rowid: number): string {
  return `
    tell application "Mail"
      set hits to (every message of drafts mailbox whose id is ${draftRowid(rowid)})
      repeat with m in hits
        delete m
      end repeat
      return (count of hits)
    end tell`;
}

/**
 * Mail forbids editing a saved draft in place, so updating is delete and
 * recreate, in one script. Order matters: the guard runs first so a missing
 * draft creates nothing, and the replacement is created and saved before the
 * old draft is deleted, so a failure partway through can never lose the
 * draft. The precise trade: a failure between the save and the delete leaves
 * both drafts, so the worst outcome is a duplicate in Drafts to remove by
 * hand, never a lost draft. The replacement gets a new id.
 */
export function buildUpdateDraftScript(rowid: number, d: DraftSpec): string {
  const id = draftRowid(rowid);
  return `
    tell application "Mail"
      set oldDrafts to (every message of drafts mailbox whose id is ${id})
      if (count of oldDrafts) is 0 then return 0
      ${makeDraftStatements(d)}
      repeat with m in oldDrafts
        delete m
      end repeat
      return (count of oldDrafts)
    end tell`;
}

export const createDraft = (d: DraftSpec) => runAppleScript(buildDraftScript(d));
export const updateDraft = (rowid: number, d: DraftSpec) => count(buildUpdateDraftScript(rowid, d));
export const deleteDraft = (rowid: number) => count(buildDeleteDraftScript(rowid));
