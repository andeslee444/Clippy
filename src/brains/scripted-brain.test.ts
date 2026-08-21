import { describe, it, expect } from "vitest";
import { ScriptedBrain } from "./scripted-brain.js";
import type { BrainTools } from "./types.js";
import { DEFAULT_OBJECTIVE } from "../orchestrator/types.js";

const tools = (results: string[]): BrainTools => {
  let i = 0;
  return {
    steps: [],
    readPage: async () => 'g1-r0 button "Apply"',
    capturePage: async () => ({ base64: "" }),
    perform: async () => results[i++] ?? "ok — done",
  };
};
const obj = { ...DEFAULT_OBJECTIVE, goal: "test" };
const script = [{ kind: "fill" as const, match: "Apply", value: "x" }];

describe("ScriptedBrain", () => {
  it("reports done when every step succeeded", async () => {
    const r = await new ScriptedBrain([...script]).pursue(obj, tools(["ok — fill ok"]));
    expect(r.kind).toBe("done");
  });

  it("reports FAILED when a step errored — not done", async () => {
    // Regression: `demo <submitRef>` built a fill against a button, the fill
    // failed, and the run still printed DONE.
    const r = await new ScriptedBrain([...script]).pursue(obj, tools(["ERROR: not an input"]));
    expect(r.kind).toBe("failed");
    if (r.kind !== "failed") throw new Error("unreachable");
    expect(r.reason).toContain("not an input");
  });

  it("reports stuck when the human declines", async () => {
    const r = await new ScriptedBrain([...script]).pursue(obj, tools(["DECLINED: approval denied"]));
    expect(r.kind).toBe("stuck");
  });

  it("stops at the declined step rather than running the rest", async () => {
    const two = [...script, { kind: "click" as const, match: "Apply" }];
    const t = tools(["DECLINED: nope", "ok — click ok"]);
    const r = await new ScriptedBrain([...two]).pursue(obj, t);
    expect(r.steps).toBe(1);
  });

  it("fails clearly when nothing on the page matches", async () => {
    const r = await new ScriptedBrain([{ kind: "fill", match: "Nonexistent", value: "x" }])
      .pursue(obj, tools(["ok — fill ok"]));
    expect(r.kind).toBe("failed");
    if (r.kind !== "failed") throw new Error("unreachable");
    expect(r.reason).toContain("Nonexistent");
  });

  it("findRef matches an accessible name case-insensitively", async () => {
    const { findRef } = await import("./scripted-brain.js");
    const tree = 'g9-r0 link ""\ng9-r7 textbox "First Name*"\ng9-r9 button "Submit application"';
    expect(findRef(tree, "first")).toBe("g9-r7");
    expect(findRef(tree, "Submit")).toBe("g9-r9");
    expect(findRef(tree, "nope")).toBeNull();
  });
});
