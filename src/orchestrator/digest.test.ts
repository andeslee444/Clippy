import { describe, it, expect } from "vitest";
import { digestStep, compactHistory } from "./digest.js";
import type { StepRecord } from "./types.js";

const rec = (over: Partial<StepRecord> = {}): StepRecord => ({
  action: { kind: "fill", ref: "g1-r2", value: "Andes" },
  outcome: { kind: "ok" },
  effect: "field now reads 'Andes'",
  ...over,
});

describe("digestStep", () => {
  it("renders one line naming the action and what changed", () => {
    expect(digestStep(rec())).toBe(`fill g1-r2 "Andes" → field now reads 'Andes'`);
  });

  it("marks a failed step with its reason", () => {
    const line = digestStep(rec({ outcome: { kind: "retry", reason: "element not found" } }));
    expect(line).toContain("element not found");
  });

  it("truncates a very long fill value", () => {
    const line = digestStep(rec({ action: { kind: "fill", ref: "g1-r2", value: "x".repeat(500) } }));
    expect(line.length).toBeLessThan(160);
  });

  it("renders navigation by url", () => {
    const line = digestStep(rec({ action: { kind: "navigate", url: "https://x.test/apply" } }));
    expect(line).toContain("https://x.test/apply");
  });

  it("never emits a newline — one step is one line", () => {
    expect(digestStep(rec({ effect: "a\nb\nc" }))).not.toContain("\n");
  });
});

describe("compactHistory", () => {
  it("keeps the most recent page tree and drops earlier ones", () => {
    const out = compactHistory(
      [rec(), rec(), rec()],
      ["<tree 1 — 2000 chars>", "<tree 2>", "<tree 3 — current>"],
    );
    expect(out).toContain("<tree 3 — current>");
    expect(out).not.toContain("<tree 1");
    expect(out).not.toContain("<tree 2");
  });

  it("keeps every step line — the action history is what the model reasons over", () => {
    const steps = Array.from({ length: 30 }, (_, i) => rec({ effect: `change ${i}` }));
    const out = compactHistory(steps, ["<tree>"]);
    expect(out).toContain("change 0");
    expect(out).toContain("change 29");
  });

  it("stays small even after many steps", () => {
    const steps = Array.from({ length: 40 }, () => rec());
    const trees = Array.from({ length: 40 }, (_, i) => `<tree ${i}>`.padEnd(2000, "."));
    // 40 raw trees would be ~80KB. One tree plus 40 short lines is a fraction of that.
    expect(compactHistory(steps, trees).length).toBeLessThan(8000);
  });

  it("handles an empty history", () => {
    expect(compactHistory([], ["<tree>"])).toContain("<tree>");
  });
});
