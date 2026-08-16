/**
 * Maximum metadata candidates a body scan will read files for before
 * refusing. Scanning the whole store takes 60 to 90 seconds, and a silent
 * scan or a silent truncation are both worse than an honest refusal.
 */
export const BODY_SCAN_CAP = 5000;

/**
 * Ceiling for trusted internal callers of EnvelopeStore.searchMessages.
 * Derived so a body scan can always fetch one row past the cap and detect
 * overflow. Deriving it makes the two constants impossible to drift apart.
 */
export const INTERNAL_LIMIT_MAX = BODY_SCAN_CAP + 1;

/**
 * Largest attachment get_attachment will return, in raw bytes before base64.
 * Base64 inflates by a third, so this cap bounds the tool result near 14 MB,
 * which typical MCP clients and model contexts can still swallow. It covers
 * almost all documents and images while refusing the videos and archives
 * that would balloon into a response most clients choke on. Over the cap the
 * tool refuses and names both numbers, in line with the body scan cap:
 * honest refusal over silent truncation.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
