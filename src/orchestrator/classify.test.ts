import { describe, it, expect } from "vitest";
import { classify } from "./classify.js";
import { StaleRefError, SubmitCapableError } from "../hands/browser/act.js";
import { ApprovalDeniedError } from "../hands/execute.js";

describe("classify", () => {
  it("stale ref is a FREE retry — nothing executed", () => {
    expect(classify(new StaleRefError("g1-r3")).kind).toBe("retry-free");
  });

  it("a refused click on a submit control is a chargeable retry", () => {
    // The model mislabelled its own action. Tell it, charge it, let it correct.
    expect(classify(new SubmitCapableError("g1-r9")).kind).toBe("retry");
  });

  it("approval denied is STUCK, not failed — the human is the blocker", () => {
    const out = classify(new ApprovalDeniedError({ kind: "submit", ref: "g1-r9" }));
    expect(out.kind).toBe("stuck");
  });

  it("a validation rejection is a chargeable retry", () => {
    expect(classify(new Error("malformed ref")).kind).toBe("retry");
  });

  it("a login wall is STUCK", () => {
    expect(classify(new Error("Login required to continue")).kind).toBe("stuck");
  });

  it("a CAPTCHA is STUCK and never attempted", () => {
    expect(classify(new Error("Please complete the reCAPTCHA")).kind).toBe("stuck");
  });

  it("a navigation timeout is a chargeable retry", () => {
    expect(classify(new Error("Timeout 30000ms exceeded")).kind).toBe("retry");
  });

  it("carries a human-readable reason through", () => {
    const out = classify(new Error("Timeout 30000ms exceeded"));
    if (out.kind === "ok") throw new Error("unreachable");
    expect(out.reason).toContain("Timeout");
  });
});
