import { describe, it, expect, vi } from "vitest";
import { StaleRefError, SubmitCapableError, performEffect } from "./act.js";

function fakePage(opts: { found?: boolean; submitCapable?: boolean; swallowsFill?: boolean } = {}) {
  const found = opts.found ?? true;
  const calls: string[] = [];
  const locator = {
    count: async () => (found ? 1 : 0),
    getAttribute: async (n: string) =>
      n === "data-clippy-submit" && opts.submitCapable ? "1" : null,
    evaluate: async () => ({ submitCapable: Boolean(opts.submitCapable), formless: false }),
    click: vi.fn(async () => { calls.push("click"); }),
    fill: vi.fn(async (v: string) => { calls.push(`fill:${v}`); }),
    inputValue: async () => (opts.swallowsFill ? "" : "written"),
    selectOption: vi.fn(async (v: string) => { calls.push(`select:${v}`); }),
    setInputFiles: vi.fn(async (p: string) => { calls.push(`upload:${p}`); }),
  };
  const locatorFn = vi.fn(() => locator);
  return {
    page: {
      locator: locatorFn,
      goto: vi.fn(async (u: string) => { calls.push(`goto:${u}`); }),
      waitForLoadState: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
    } as any,
    locator,
    locatorFn,
    calls,
  };
}

describe("performEffect", () => {
  it("addresses the element by its exact ref", async () => {
    const { page, locatorFn } = fakePage();
    await performEffect(page, { kind: "click", ref: "g1-r3" });
    expect(locatorFn).toHaveBeenCalledWith(`[data-clippy-ref="g1-r3"]`);
  });

  it("clicks an ordinary control", async () => {
    const { page, calls } = fakePage();
    await performEffect(page, { kind: "click", ref: "g1-r3" });
    expect(calls).toContain("click");
  });

  it("fills, selects, and uploads", async () => {
    const f = fakePage();
    await performEffect(f.page, { kind: "fill", ref: "g1-r2", value: "Andes" });
    expect(f.calls).toContain("fill:Andes");

    const s = fakePage();
    await performEffect(s.page, { kind: "select", ref: "g1-r4", value: "Yes" });
    expect(s.calls).toContain("select:Yes");

    const u = fakePage();
    const path = `${process.cwd()}/documents/cv.docx`;
    await performEffect(u.page, { kind: "upload", ref: "g1-r5", path });
    expect(u.calls).toContain(`upload:${path}`);
  });

  it("throws StaleRefError when the ref is not on the page", async () => {
    const { page } = fakePage({ found: false });
    await expect(performEffect(page, { kind: "click", ref: "g1-r3" }))
      .rejects.toBeInstanceOf(StaleRefError);
  });

  it("executes NOTHING when the ref is stale", async () => {
    const { page, locator } = fakePage({ found: false });
    await performEffect(page, { kind: "click", ref: "g1-r3" }).catch(() => {});
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("REFUSES a click on a submit-capable element", async () => {
    const { page } = fakePage({ submitCapable: true });
    await expect(performEffect(page, { kind: "click", ref: "g1-r9" }))
      .rejects.toBeInstanceOf(SubmitCapableError);
  });

  it("executes NOTHING when refusing a submit-capable click", async () => {
    const { page, locator } = fakePage({ submitCapable: true });
    await performEffect(page, { kind: "click", ref: "g1-r9" }).catch(() => {});
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("allows submit on a submit-capable element", async () => {
    const { page, calls } = fakePage({ submitCapable: true });
    await performEffect(page, { kind: "submit", ref: "g1-r9" });
    expect(calls).toContain("click");
  });

  it("rejects an injected ref before touching the page", async () => {
    const { page, locatorFn } = fakePage();
    await expect(
      performEffect(page, { kind: "click", ref: `g1-r0"], button[type="submit` } as any),
    ).rejects.toThrow();
    expect(locatorFn).not.toHaveBeenCalled();
  });

  it("rejects file:// navigation before touching the page", async () => {
    const { page } = fakePage();
    await expect(
      performEffect(page, { kind: "navigate", url: "file:///etc/passwd" } as any),
    ).rejects.toThrow();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("navigates to https without needing a ref", async () => {
    const { page, calls } = fakePage({ found: false });
    await performEffect(page, { kind: "navigate", url: "https://example.com/" });
    expect(calls).toContain("goto:https://example.com/");
  });
});

describe("performEffect — a fill that changes nothing is a failure", () => {
  it("accepts a fill that lands", async () => {
    const { page } = fakePage();
    await expect(performEffect(page, { kind: "fill", ref: "g1-r2", value: "Andes" }))
      .resolves.toBeUndefined();
  });

  it("REJECTS a fill the widget silently swallowed", async () => {
    // Custom ATS comboboxes accept fill() without error and discard the value.
    // Reporting ok made the model refill the same field forever — observed live
    // as 36 fills across 27 page reads before the step budget stopped it.
    const { page } = fakePage({ swallowsFill: true });
    await expect(performEffect(page, { kind: "fill", ref: "g1-r2", value: "Andes" }))
      .rejects.toThrow(/did not take/);
  });

  it("tells the model what to try instead", async () => {
    const { page } = fakePage({ swallowsFill: true });
    await expect(performEffect(page, { kind: "fill", ref: "g1-r2", value: "x" }))
      .rejects.toThrow(/custom widget|choose from the list/);
  });

  it("does not police an empty fill — clearing a field is legitimate", async () => {
    const { page } = fakePage({ swallowsFill: true });
    await expect(performEffect(page, { kind: "fill", ref: "g1-r2", value: "" }))
      .resolves.toBeUndefined();
  });
});

