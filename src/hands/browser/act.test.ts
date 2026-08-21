import { describe, it, expect, vi } from "vitest";
import { StaleRefError, performAction } from "./act.js";

/** Minimal Page stub: only what performAction touches. */
function fakePage(opts: { found: boolean }) {
  const calls: string[] = [];
  const locator = {
    count: async () => (opts.found ? 1 : 0),
    click: vi.fn(async () => { calls.push("click"); }),
    fill: vi.fn(async (v: string) => { calls.push(`fill:${v}`); }),
    selectOption: vi.fn(async (v: string) => { calls.push(`select:${v}`); }),
    setInputFiles: vi.fn(async (p: string) => { calls.push(`upload:${p}`); }),
  };
  return {
    page: {
      locator: () => locator,
      goto: vi.fn(async (u: string) => { calls.push(`goto:${u}`); }),
      waitForLoadState: vi.fn(async () => {}),
    } as any,
    locator,
    calls,
  };
}

describe("performAction", () => {
  it("clicks the element matching the ref", async () => {
    const { page, calls } = fakePage({ found: true });
    await performAction(page, { kind: "click", ref: "g1-r3" });
    expect(calls).toContain("click");
  });

  it("fills a value", async () => {
    const { page, calls } = fakePage({ found: true });
    await performAction(page, { kind: "fill", ref: "g1-r2", value: "Andes" });
    expect(calls).toContain("fill:Andes");
  });

  it("throws StaleRefError when the ref is not on the page", async () => {
    const { page } = fakePage({ found: false });
    await expect(
      performAction(page, { kind: "click", ref: "g1-r3" }),
    ).rejects.toBeInstanceOf(StaleRefError);
  });

  it("does NOT execute anything when the ref is stale", async () => {
    const { page, locator } = fakePage({ found: false });
    await performAction(page, { kind: "click", ref: "g1-r3" }).catch(() => {});
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("treats submit as a click on the referenced element", async () => {
    const { page, calls } = fakePage({ found: true });
    await performAction(page, { kind: "submit", ref: "g1-r9" });
    expect(calls).toContain("click");
  });

  it("navigates without needing a ref", async () => {
    const { page, calls } = fakePage({ found: false });
    await performAction(page, { kind: "navigate", url: "https://example.com" });
    expect(calls).toContain("goto:https://example.com");
  });
});
