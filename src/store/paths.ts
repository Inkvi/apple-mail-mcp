import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shard directories under Data/ are the digits of rowid/1000, reversed.
 * ROWID 159566 lives under Data/9/5/1/Messages/. Ids below 1000 are
 * unsharded and live directly under Data/Messages/.
 * Verified against all 103,315 .emlx files in a real store.
 */
export function shardFor(rowid: number): string {
  if (rowid < 1000) return "";
  return String(Math.trunc(rowid / 1000)).split("").reverse().join("/");
}

/**
 * mailboxes.url is imap://<ACCOUNT-UUID>/<url-encoded>/<path>.
 * Each segment decodes and gains a .mbox suffix. The URL parser preserves
 * host case for non-special schemes such as imap:, so hostname is safe.
 */
export function mailboxDir(storeRoot: string, mailboxUrl: string): string {
  const u = new URL(mailboxUrl);
  const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let dir = join(storeRoot, u.hostname);
  for (const segment of segments) dir = join(dir, `${segment}.mbox`);
  return dir;
}

const storeUuidCache = new Map<string, string | null>();

/** The UUID directory between <name>.mbox and Data/. One readdir, then cached. */
function storeUuidFor(mboxDir: string): string | null {
  if (storeUuidCache.has(mboxDir)) return storeUuidCache.get(mboxDir) ?? null;
  let found: string | null = null;
  try {
    found = readdirSync(mboxDir).find((e) => /^[0-9A-F]{8}-[0-9A-F]{4}-/i.test(e)) ?? null;
  } catch {
    found = null;
  }
  storeUuidCache.set(mboxDir, found);
  return found;
}

/**
 * Resolve a message to its file with no filesystem search.
 * Returns null when the body is not on disk, which is normal for
 * Exchange accounts. partial=true means the download is incomplete.
 */
export function resolveMessageFile(
  storeRoot: string,
  mailboxUrl: string,
  rowid: number,
): { path: string; partial: boolean } | null {
  const mbox = mailboxDir(storeRoot, mailboxUrl);
  const uuid = storeUuidFor(mbox);
  if (!uuid) return null;

  const shard = shardFor(rowid);
  const dir = shard
    ? join(mbox, uuid, "Data", shard, "Messages")
    : join(mbox, uuid, "Data", "Messages");

  const full = join(dir, `${rowid}.emlx`);
  if (existsSync(full)) return { path: full, partial: false };

  const partial = join(dir, `${rowid}.partial.emlx`);
  if (existsSync(partial)) return { path: partial, partial: true };

  return null;
}

/** Newest V<n> directory under ~/Library/Mail, or null if Mail has never run. */
export function findStoreRoot(): string | null {
  const base = join(homedir(), "Library", "Mail");
  try {
    const versions = readdirSync(base)
      .filter((e) => /^V\d+$/.test(e))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    return versions.length > 0 ? join(base, versions[0]!) : null;
  } catch {
    return null;
  }
}
