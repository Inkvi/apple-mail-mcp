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
