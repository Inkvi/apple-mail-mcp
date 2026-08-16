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
