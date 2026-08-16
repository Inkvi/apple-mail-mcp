import { escapeAppleScript, runAppleScript } from "./applescript";

/**
 * Ids come from SQLite and are interpolated as bare numbers, so they are
 * validated as integers here. This is the only place a non-string value
 * reaches a generated script.
 */
/**
 * Build the `whose` predicate that selects the wanted messages.
 *
 * This is an `or` chain rather than the more obvious `id is in {1, 2, 3}`.
 * Mail accepts `is in` against a list without error but matches nothing: it
 * returns zero messages and the mutation silently becomes a no-op. Verified
 * live on this machine, 2026-08-16, against a message that `id is <n>` found
 * in the same mailbox in the same run. Every write tool routes through here,
 * so `is in` made flag, read, move, and delete all quietly do nothing.
 *
 * Ids come from SQLite and are interpolated as bare numbers, so they are
 * validated as integers here. This is the only place a non-string value
 * reaches a generated script.
 */
function idPredicate(rowids: number[]): string {
  if (rowids.length === 0) throw new Error("no message ids given");
  for (const id of rowids) {
    if (!Number.isInteger(id)) throw new Error(`message id must be an integer, got ${id}`);
  }
  return rowids.map((id) => `id is ${id}`).join(" or ");
}

/**
 * Sweep every mailbox and apply `mutation` to each matching message as it is
 * found, counting the hits.
 *
 * The mutation runs inside the loop that found the message, rather than
 * against a list collected in an earlier pass. A collected reference is a
 * positional specifier ("item 1 of every message of item 4 of every mailbox
 * of item 6 of every account"), and Mail re-resolves it when it is used. Any
 * mailbox change between the two passes invalidates it: collecting first and
 * moving afterwards failed with error -1728, on this machine, 2026-08-16.
 *
 * `setup` runs before the sweep, for work that must not repeat per message
 * (resolving a move destination). Resolving it first also means an
 * unreachable destination fails before anything has been mutated.
 *
 * The per-mailbox query is wrapped in `try` because some accounts are
 * unreachable (a disabled iCloud account raises rather than returning
 * nothing), and one unreachable account must not abort the whole sweep.
 *
 * Hits are walked backwards by index. `move` and `delete` remove the message
 * from the mailbox the query just enumerated, so walking forwards renumbers
 * the collection underneath the loop: that failed with error -10000 live on
 * this machine, 2026-08-16, where the same delete walked backwards
 * succeeded. Flag and read do not shrink the collection, but they run the
 * same way rather than keeping two loop shapes for one behaviour.
 */
function sweep(rowids: number[], mutation: string, setup = ""): string {
  return `
    tell application "Mail"
      ${setup}
      set n to 0
      repeat with acct in every account
        repeat with box in every mailbox of acct
          try
            set hits to (every message of box whose ${idPredicate(rowids)})
          on error
            set hits to {}
          end try
          repeat with i from (count of hits) to 1 by -1
            set m to item i of hits
            ${mutation}
            set n to n + 1
          end repeat
        end repeat
      end repeat
      return n
    end tell`;
}

export function buildMarkReadScript(rowids: number[], read: boolean): string {
  return sweep(rowids, `set read status of m to ${read ? "true" : "false"}`);
}

export function buildFlagScript(rowids: number[], flagged: boolean): string {
  return sweep(rowids, `set flagged status of m to ${flagged ? "true" : "false"}`);
}

export function buildMoveScript(rowids: number[], targetMailbox: string, account: string): string {
  return sweep(
    rowids,
    "move m to destination",
    `set destination to mailbox "${escapeAppleScript(targetMailbox)}" of account "${escapeAppleScript(account)}"`,
  );
}

/**
 * Deletion means moving to Trash. Nothing here erases mail: verified live on
 * this machine, 2026-08-16, where deleting a message in Gmail's All Mail
 * produced a new row in Trash rather than removing it.
 *
 * This uses `delete`, not `set deleted status of m to true`. The status form
 * fails with error -609 (connection is invalid) against Gmail IMAP, on
 * ordinary messages as well as drafts, and reports no error to the caller
 * beyond the raised script failure. `delete` is the same verb the draft path
 * already had to use for the same reason.
 */
export function buildDeleteScript(rowids: number[]): string {
  return sweep(rowids, "delete m");
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
