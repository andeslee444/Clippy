import type { Objective, StepOutcome } from "./types.js";

/**
 * Free retries do not consume the step budget, so they need their own ceiling —
 * otherwise a page that re-renders on every observation spins forever at zero
 * recorded cost. This is generous: real staleness resolves in one or two.
 */
const MAX_FREE_RETRIES = 25;

export class BudgetTracker {
  steps = 0;
  freeRetries = 0;
  cost = 0;

  constructor(private readonly limits: Pick<Objective, "maxSteps" | "maxCost">) {}

  record(outcome: StepOutcome): void {
    if (outcome.kind === "retry-free") {
      this.freeRetries += 1;
      return;
    }
    this.steps += 1;
  }

  spend(usd: number): void {
    this.cost += usd;
  }

  /** Why the objective must stop, or null if it may continue. */
  exhausted(): string | null {
    if (this.steps >= this.limits.maxSteps) {
      return `step budget exhausted (${this.steps}/${this.limits.maxSteps})`;
    }
    if (this.cost >= this.limits.maxCost) {
      return `cost budget exhausted ($${this.cost.toFixed(2)}/$${this.limits.maxCost.toFixed(2)})`;
    }
    if (this.freeRetries >= MAX_FREE_RETRIES) {
      return `too many stale-ref re-renders (${this.freeRetries}) — the page will not settle`;
    }
    return null;
  }
}
