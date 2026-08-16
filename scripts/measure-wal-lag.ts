/**
 * Measures how long after an AppleScript mutation the change becomes visible
 * in the Envelope Index. The output sets the coherence overlay TTL (Task 10).
 *
 * Throwaway measurement script, not shipped code. It toggles the flagged
 * status of ONE controller-selected spam message five times, polling two
 * readers on every iteration:
 *   1. a long-lived EnvelopeStore opened once before the loop (the MCP
 *      server's real read path, one connection for its whole lifetime)
 *   2. a fresh EnvelopeStore constructed per poll
 * It records when each first observes the change, then restores the flag to
 * its original state and verifies the restore in both AppleScript and SQLite.
 */
import { runAppleScript } from "../src/mail/applescript";
import { EnvelopeStore } from "../src/store/envelope";
import { findStoreRoot } from "../src/store/paths";

// Target is supplied on the command line, because it is specific to whoever
// runs this. Pick a message you are happy to flag and unflag five times: the
// script toggles it and restores the original value.
//
// Give the mailbox as its full path. For nested Gmail mailboxes the full form
// "[Gmail]/Spam" is required; the leaf name "Spam" does not resolve.
const [ACCOUNT_ID, MAILBOX_PATH, MESSAGE_ID_ARG] = process.argv.slice(2);
if (!ACCOUNT_ID || !MAILBOX_PATH || !MESSAGE_ID_ARG) {
  console.error(
    'usage: bun run scripts/measure-wal-lag.ts <account-uuid> <mailbox-path> <rowid>\n' +
      'example: bun run scripts/measure-wal-lag.ts 11111111-2222-4000-8000-333333333333 "[Gmail]/Spam" 209947',
  );
  process.exit(2);
}
const MESSAGE_ID = Number(MESSAGE_ID_ARG);
if (!Number.isInteger(MESSAGE_ID) || MESSAGE_ID <= 0) {
  console.error(`rowid must be a positive integer, got: ${MESSAGE_ID_ARG}`);
  process.exit(2);
}
const EXPECTED_MAILBOX_URL = `imap://${ACCOUNT_ID}/%5BGmail%5D/Spam`;

const ITERATIONS = 5;
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 10;

function mailScript(body: string): string {
  return `
    tell application "Mail"
      set acct to (first account whose id is "${ACCOUNT_ID}")
      set box to mailbox "${MAILBOX_PATH}" of acct
      set m to (first message of box whose id is ${MESSAGE_ID})
      ${body}
    end tell`;
}

async function readFlagViaAppleScript(): Promise<boolean> {
  const out = (await runAppleScript(mailScript("return flagged status of m"))).trim();
  if (out !== "true" && out !== "false") {
    throw new Error(`unexpected AppleScript output: ${JSON.stringify(out)}`);
  }
  return out === "true";
}

async function setFlagViaAppleScript(desired: boolean): Promise<void> {
  await runAppleScript(mailScript(`set flagged status of m to ${desired}`));
}

const root = findStoreRoot();
if (!root) throw new Error("no Mail store found");

// Pre-flight in SQLite: the message must exist, be in the expected mailbox,
// and have the expected rowid. Abort without mutating otherwise.
const preflight = new EnvelopeStore(root);
const before = preflight.getMessage(MESSAGE_ID);
preflight.close();
if (!before) throw new Error(`message ${MESSAGE_ID} not found in Envelope Index, aborting`);
if (before.rowid !== MESSAGE_ID) throw new Error(`rowid mismatch: ${before.rowid}, aborting`);
if (before.mailboxUrl !== EXPECTED_MAILBOX_URL) {
  throw new Error(`message is in ${before.mailboxUrl}, expected ${EXPECTED_MAILBOX_URL}, aborting`);
}

// Pre-flight in AppleScript: the same message must resolve there too, and
// its flag state must agree with SQLite before we touch anything.
const originalFlag = await readFlagViaAppleScript();
if (originalFlag !== before.flagged) {
  throw new Error(
    `flag state disagrees before start: AppleScript=${originalFlag} SQLite=${before.flagged}, aborting`,
  );
}

console.log(`Target: rowid=${MESSAGE_ID} in ${MAILBOX_PATH} of account ${ACCOUNT_ID}`);
console.log(`Original state: flagged=${originalFlag} read=${before.read}`);
console.log(`Subject: ${before.subject}`);
console.log("");

interface Sample {
  iteration: number;
  osascriptMs: number;
  longLivedLagMs: number;
  freshLagMs: number;
}

const samples: Sample[] = [];
const longLived = new EnvelopeStore(root);
let aborted = false;

try {
  let current = originalFlag;
  for (let i = 0; i < ITERATIONS; i++) {
    const desired = !current;

    const started = performance.now();
    await setFlagViaAppleScript(desired);
    const afterScript = performance.now();
    current = desired;

    let longLivedAt = -1;
    let freshAt = -1;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline && (longLivedAt < 0 || freshAt < 0)) {
      if (longLivedAt < 0 && longLived.getMessage(MESSAGE_ID)?.flagged === desired) {
        longLivedAt = performance.now();
      }
      if (freshAt < 0) {
        const fresh = new EnvelopeStore(root);
        const seen = fresh.getMessage(MESSAGE_ID);
        fresh.close();
        if (seen?.flagged === desired) freshAt = performance.now();
      }
      if (longLivedAt < 0 || freshAt < 0) await Bun.sleep(POLL_INTERVAL_MS);
    }

    if (longLivedAt < 0 || freshAt < 0) {
      console.log(
        `iteration ${i + 1}: NOT VISIBLE within ${POLL_TIMEOUT_MS}ms ` +
          `(long-lived ${longLivedAt < 0 ? "missed" : "saw it"}, fresh ${freshAt < 0 ? "missed" : "saw it"})`,
      );
      aborted = true;
      break;
    }

    const sample: Sample = {
      iteration: i + 1,
      osascriptMs: afterScript - started,
      longLivedLagMs: longLivedAt - afterScript,
      freshLagMs: freshAt - afterScript,
    };
    samples.push(sample);
    console.log(
      `iteration ${sample.iteration}: osascript ${sample.osascriptMs.toFixed(0)}ms, ` +
        `long-lived saw it after ${sample.longLivedLagMs.toFixed(0)}ms, ` +
        `fresh saw it after ${sample.freshLagMs.toFixed(0)}ms`,
    );
  }
} finally {
  longLived.close();

  // Restore the original flag state no matter what happened above,
  // then verify the restore in both AppleScript and SQLite.
  await setFlagViaAppleScript(originalFlag);
  const restoredScript = await readFlagViaAppleScript();

  let restoredSqlite: boolean | undefined;
  const restoreDeadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < restoreDeadline) {
    const check = new EnvelopeStore(root);
    restoredSqlite = check.getMessage(MESSAGE_ID)?.flagged;
    check.close();
    if (restoredSqlite === originalFlag) break;
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  console.log("");
  console.log(`Restore: original flagged=${originalFlag}`);
  console.log(`  AppleScript now reports flagged=${restoredScript} ${restoredScript === originalFlag ? "(OK)" : "(MISMATCH)"}`);
  console.log(`  SQLite now reports flagged=${restoredSqlite} ${restoredSqlite === originalFlag ? "(OK)" : "(MISMATCH)"}`);
  if (restoredScript !== originalFlag || restoredSqlite !== originalFlag) {
    console.error("RESTORE FAILED, manual intervention needed");
    process.exitCode = 1;
  }
}

if (aborted) {
  console.error("\nA change was not visible within the timeout. Stopped early; see above.");
  process.exit(1);
}

function stats(values: number[]): { median: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, max: sorted.at(-1)! };
}

if (samples.length > 0) {
  const long = stats(samples.map((s) => s.longLivedLagMs));
  const fresh = stats(samples.map((s) => s.freshLagMs));
  console.log("");
  console.log(`long-lived lag (ms): ${samples.map((s) => s.longLivedLagMs.toFixed(0)).join(", ")}`);
  console.log(`fresh lag (ms):      ${samples.map((s) => s.freshLagMs.toFixed(0)).join(", ")}`);
  console.log(`long-lived: median ${long.median.toFixed(0)}ms, max ${long.max.toFixed(0)}ms`);
  console.log(`fresh:      median ${fresh.median.toFixed(0)}ms, max ${fresh.max.toFixed(0)}ms`);
  const worstMax = Math.max(long.max, fresh.max);
  console.log(`Suggested overlay TTL: ${Math.ceil((worstMax * 4) / 1000) * 1000}ms (4x observed max, sanity-check against a floor)`);
}
