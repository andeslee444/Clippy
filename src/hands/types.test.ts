import { describe, it, expect } from "vitest";
import { EFFECT_META, type Effect, type Observation } from "./types.js";

describe("provenance on fill/select", () => {
  it("is optional — an unset provenance stays absent, not defaulted", () => {
    const filled: Effect = { kind: "fill", ref: "g1-r1", value: "x" };
    expect("provenance" in filled).toBe(false);
  });

  it("carries the provenance value through when set", () => {
    const selected: Effect = { kind: "select", ref: "g1-r2", value: "y", provenance: "generated" };
    expect(selected.kind === "select" && selected.provenance).toBe("generated");
  });
});

describe("EFFECT_META", () => {
  it("declares metadata for every effect kind", () => {
    const kinds: Effect["kind"][] = ["navigate", "click", "fill", "select", "upload", "submit"];
    for (const k of kinds) expect(EFFECT_META[k], `missing meta for ${k}`).toBeDefined();
  });

  it("marks submit as outward-facing and irreversible", () => {
    expect(EFFECT_META.submit).toEqual({ reversible: false, outwardFacing: true });
  });

  it("marks upload as outward-facing — ATS platforms upload on attach", () => {
    expect(EFFECT_META.upload).toEqual({ reversible: false, outwardFacing: true });
  });

  it("marks ordinary form interaction as reversible and internal", () => {
    expect(EFFECT_META.fill).toEqual({ reversible: true, outwardFacing: false });
    expect(EFFECT_META.click).toEqual({ reversible: true, outwardFacing: false });
  });

  it("has no entry for observations — they cannot be gated", () => {
    const observationKinds: Observation["kind"][] = ["readPage", "capturePage"];
    for (const k of observationKinds) {
      expect(Object.keys(EFFECT_META)).not.toContain(k);
    }
  });
});
