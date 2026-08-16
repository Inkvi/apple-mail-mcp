import type { FullMessage } from "../dispatcher";

/** The slice of a message that reply and forward composition read. */
export type ComposeSource = Pick<FullMessage, "subject" | "sender" | "dateReceived" | "text" | "to">;

/**
 * Prefix the subject once: a requested subject already carrying the prefix
 * is kept, and an original already carrying it is never prefixed again.
 */
function prefixSubject(prefix: "Re" | "Fwd", requested: string, original: string | null): string {
  const has = new RegExp(`^${prefix}:`, "i");
  if (has.test(requested) || !original) return requested;
  return has.test(original) ? original : `${prefix}: ${original}`;
}

export function composeReply(
  original: ComposeSource,
  subject: string,
  body: string,
): { subject: string; body: string } {
  const quoted = (original.text ?? "").split("\n").map((l) => `> ${l}`).join("\n");
  return {
    subject: prefixSubject("Re", subject, original.subject),
    body:
      `${body}\n\nOn ${new Date(original.dateReceived * 1000).toLocaleString()}, ` +
      `${original.sender ?? "someone"} wrote:\n${quoted}`,
  };
}

export function composeForward(
  original: ComposeSource,
  subject: string,
  body: string,
): { subject: string; body: string } {
  const headers = [
    `From: ${original.sender ?? "unknown"}`,
    `Date: ${new Date(original.dateReceived * 1000).toLocaleString()}`,
    `Subject: ${original.subject ?? ""}`,
    ...(original.to.length > 0 ? [`To: ${original.to.join(", ")}`] : []),
  ].join("\n");
  return {
    subject: prefixSubject("Fwd", subject, original.subject),
    body: `${body}\n\nBegin forwarded message:\n\n${headers}\n\n${original.text ?? ""}`,
  };
}
