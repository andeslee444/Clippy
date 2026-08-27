import { describe, it, expect, vi } from "vitest";
import { makeTools } from "./tools.js";
import { ApprovalDeniedError } from "../hands/execute.js";
import { StaleRefError } from "../hands/browser/act.js";

const deps = (over: Partial<Parameters<typeof makeTools>[0]> = {}) => ({
  runEffect: vi.fn(async () => {}),
  readPage: vi.fn(async () => "g1-r0 button \"Apply\""),
  capturePage: vi.fn(async () => ({ base64: "AAA" })),
  onStep: vi.fn(),
  ...over,
});

describe("makeTools", () => {
  it("performs a valid effect and reports success", async () => {
    const d = deps();
    const out = await makeTools(d).perform({ kind: "fill", ref: "g1-r2", value: "Andes" });
    expect(d.runEffect).toHaveBeenCalledOnce();
    expect(out).toMatch(/ok|done|filled/i);
  });

  it("turns a denied approval into a RESULT, not an exception", async () => {
    // The model must be able to read "declined" and stop, not crash the run.
    const d = deps({
      runEffect: vi.fn(async () => {
        throw new ApprovalDeniedError({ kind: "submit", ref: "g1-r9" });
      }),
    });
    const out = await makeTools(d).perform({ kind: "submit", ref: "g1-r9" });
    expect(out).toMatch(/declined|denied/i);
    expect(out).toMatch(/do not retry/i);
  });

  it("turns a stale ref into a result telling the model to re-observe", async () => {
    const d = deps({
      runEffect: vi.fn(async () => { throw new StaleRefError("g1-r3"); }),
    });
    const out = await makeTools(d).perform({ kind: "click", ref: "g1-r3" });
    expect(out).toMatch(/re-?observe|read the page again/i);
  });

  it("reports each step's outcome to onStep for the history", async () => {
    const d = deps();
    await makeTools(d).perform({ kind: "click", ref: "g1-r1" });
    expect(d.onStep).toHaveBeenCalledOnce();
  });

  it("accumulates steps on the tools object for the brain to compact", async () => {
    const t = makeTools(deps());
    await t.perform({ kind: "click", ref: "g1-r1" });
    await t.perform({ kind: "fill", ref: "g1-r2", value: "x" });
    expect(t.steps).toHaveLength(2);
  });

  it("reports failures to onStep too", async () => {
    const d = deps({
      runEffect: vi.fn(async () => { throw new StaleRefError("g1-r3"); }),
    });
    await makeTools(d).perform({ kind: "click", ref: "g1-r3" });
    expect(d.onStep).toHaveBeenCalledOnce();
    expect(vi.mocked(d.onStep).mock.calls[0]![0].outcome.kind).toBe("retry-free");
  });
});

/*
 * The fourth instance of one bug: a value written by one component, read by
 * another, and populated by nothing in between at the moment it is read.
 * Previous three were budget.record (maxSteps unenforced), provenance (never
 * stamped), and readOnly (dropped by an explicit field list). Here the CLI
 * loads the profile lazily, so a résumé path captured when the tools were
 * built was `undefined` for the life of the process — and the model reported
 * "no résumé on file" while one sat in the profile.
 */
describe("makeTools — attachResume reads the path when it is needed", () => {
  const deps = (resumePath: () => string | undefined) => ({
    resumePath,
    runEffect: async () => {},
    readPage: async () => "",
    capturePage: async () => ({ base64: "" }),
    onStep: () => {},
  });

  it("sees a profile loaded AFTER the tools were built", async () => {
    let path: string | undefined;
    const tools = makeTools(deps(() => path));
    // Tools built while the profile is still null — the CLI's actual order.
    path = "/tmp/cv.pdf";
    const result = await tools.attachResume("g1-r1");
    expect(result).not.toMatch(/no résumé on file/);
  });

  it("refuses when there is genuinely no résumé", async () => {
    const tools = makeTools(deps(() => undefined));
    expect(await tools.attachResume("g1-r1")).toMatch(/no résumé on file/);
  });

  it("never invents a path", async () => {
    const tools = makeTools(deps(() => undefined));
    const result = await tools.attachResume("g1-r1");
    expect(result).toMatch(/^ERROR/);
    expect(tools.steps).toHaveLength(0);
  });
});
