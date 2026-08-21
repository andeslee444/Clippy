import { describe, it, expect } from "vitest";
import { TOOL_META, type Action } from "./types.js";

describe("TOOL_META", () => {
  it("declares metadata for every action kind", () => {
    const kinds: Action["kind"][] = [
      "navigate", "click", "fill", "select", "upload",
      "readPage", "capturePage", "submit",
    ];
    for (const k of kinds) {
      expect(TOOL_META[k], `missing meta for ${k}`).toBeDefined();
    }
  });

  it("marks submit as outward-facing and irreversible", () => {
    expect(TOOL_META.submit).toEqual({ reversible: false, outwardFacing: true });
  });

  it("marks observation actions as reversible and internal", () => {
    expect(TOOL_META.readPage).toEqual({ reversible: true, outwardFacing: false });
    expect(TOOL_META.capturePage).toEqual({ reversible: true, outwardFacing: false });
  });

  it("marks fill as reversible and internal", () => {
    expect(TOOL_META.fill).toEqual({ reversible: true, outwardFacing: false });
  });
});
