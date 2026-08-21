import { describe, it, expect } from "vitest";
import { BudgetTracker } from "./budget.js";

const t = () => new BudgetTracker({ maxSteps: 3, maxCost: 1.0 });

describe("BudgetTracker", () => {
  it("starts with budget remaining", () => {
    expect(t().exhausted()).toBeNull();
  });

  it("charges ordinary steps", () => {
    const b = t();
    b.record({ kind: "ok" });
    b.record({ kind: "ok" });
    expect(b.steps).toBe(2);
    expect(b.exhausted()).toBeNull();
  });

  it("reports exhaustion once the step ceiling is reached", () => {
    const b = t();
    for (let i = 0; i < 3; i++) b.record({ kind: "ok" });
    expect(b.exhausted()).toMatch(/step/i);
  });

  it("does NOT charge a stale-ref retry — nothing executed", () => {
    const b = t();
    for (let i = 0; i < 10; i++) b.record({ kind: "retry-free", reason: "stale" });
    expect(b.steps).toBe(0);
    expect(b.exhausted()).toBeNull();
  });

  it("still counts free retries for reporting", () => {
    const b = t();
    b.record({ kind: "retry-free", reason: "stale" });
    expect(b.freeRetries).toBe(1);
  });

  it("charges an ordinary retry", () => {
    const b = t();
    b.record({ kind: "retry", reason: "not found" });
    expect(b.steps).toBe(1);
  });

  it("reports exhaustion once the cost ceiling is reached", () => {
    const b = t();
    b.spend(0.6);
    b.spend(0.5);
    expect(b.exhausted()).toMatch(/cost/i);
  });

  it("caps runaway free retries so a re-render storm cannot spin forever", () => {
    const b = t();
    for (let i = 0; i < 200; i++) b.record({ kind: "retry-free", reason: "stale" });
    expect(b.exhausted()).toMatch(/re-render|stale/i);
  });
});
