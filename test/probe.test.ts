import { test, expect, describe } from "bun:test";
import { probeStore } from "../src/store/probe";
import { findStoreRoot } from "../src/store/paths";

describe("probeStore", () => {
  test("rejects a path that is not a Mail store", () => {
    const r = probeStore("/tmp/definitely-not-a-mail-store");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toContain("no Envelope Index at");
    expect(r.reason).toContain("/tmp/definitely-not-a-mail-store");
  });

  const root = findStoreRoot();
  test.if(!!root)("accepts the real store and reports its version", () => {
    const r = probeStore(root!);
    if (!r.ok) throw new Error(`probe failed: ${r.reason}`);
    expect(r.storeVersion).toMatch(/^V\d+$/);
    expect(r.messageCount).toBeGreaterThan(0);
  });
});
