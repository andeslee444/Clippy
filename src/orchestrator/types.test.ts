import { describe, it, expect } from "vitest";
import { DEFAULT_OBJECTIVE } from "./types.js";

describe("DEFAULT_OBJECTIVE", () => {
  it("matches the spec's opening budgets", () => {
    expect(DEFAULT_OBJECTIVE).toEqual({ maxSteps: 40, maxCost: 1.5 });
  });
});
