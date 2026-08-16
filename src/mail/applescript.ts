/**
 * Escape a value for interpolation into an AppleScript string literal.
 * Backslashes first, otherwise the backslashes introduced when escaping
 * quotes would themselves be escaped and the quoting would invert.
 * Newlines become spaces because a raw newline inside a literal ends the
 * statement and lets the rest of the value execute as code.
 */
export function escapeAppleScript(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, " ");
}

/**
 * Run a script through `osascript -`. The child is killed on timeout so a
 * hung Mail.app cannot leak processes; patrickfreyer's project hit exactly
 * this and had to add orphan tracking.
 *
 * Timeout detection uses an explicit flag rather than `child.killed`: in
 * Bun 1.3.14 `killed` is true for any exited process, even one that was
 * never sent a signal, so it cannot distinguish a timeout from a normal
 * script error.
 */
export async function runAppleScript(script: string, timeoutMs = 120_000): Promise<string> {
  const child = Bun.spawn(["osascript", "-"], {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (timedOut) {
      throw new Error(`AppleScript timed out after ${timeoutMs}ms. The operation may still have succeeded.`);
    }
    if (code !== 0) {
      throw new Error(`AppleScript failed (exit ${code}): ${stderr.trim() || "no stderr"}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
