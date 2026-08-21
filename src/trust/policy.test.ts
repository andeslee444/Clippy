import { describe, it, expect } from "vitest";
import { isGated } from "./policy.js";
import type { Action } from "../hands/types.js";

const act = (a: Action) => a;

describe("isGated", () => {
  it("gates submit — outward-facing and irreversible", () => {
    expect(isGated(act({ kind: "submit", ref: "g1-r1" }))).toBe(true);
  });

  it("does not gate observation", () => {
    expect(isGated(act({ kind: "readPage" }))).toBe(false);
    expect(isGated(act({ kind: "capturePage" }))).toBe(false);
  });

  it("does not gate ordinary form interaction", () => {
    expect(isGated(act({ kind: "fill", ref: "g1-r2", value: "Andes" }))).toBe(false);
    expect(isGated(act({ kind: "click", ref: "g1-r3" }))).toBe(false);
    expect(isGated(act({ kind: "select", ref: "g1-r4", value: "Yes" }))).toBe(false);
  });

  it("does not gate navigation", () => {
    expect(isGated(act({ kind: "navigate", url: "https://boards.greenhouse.io/x" }))).toBe(false);
  });

  it("is a pure function of the action kind", () => {
    const a = act({ kind: "submit", ref: "g1-r1" });
    expect(isGated(a)).toBe(isGated(a));
  });
});
