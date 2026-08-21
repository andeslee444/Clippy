import type { Action } from "../hands/types.js";

export interface Objective {
  /** What the user asked for, in words. */
  goal: string;
  /** Hard ceiling on chargeable steps (spec §8.1). */
  maxSteps: number;
  /** Hard ceiling on spend, USD. */
  maxCost: number;
}

export const DEFAULT_OBJECTIVE: Omit<Objective, "goal"> = { maxSteps: 40, maxCost: 1.5 };

/**
 * How one step ended (spec §8.4).
 *
 * `retry-free` is the load-bearing one: a stale ref means the page re-rendered
 * and NOTHING executed, so charging it against the budget would let a
 * re-render storm consume an objective without any work happening.
 */
export type StepOutcome =
  | { kind: "ok" }
  | { kind: "retry-free"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "stuck"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * How the objective ended.
 *
 * STUCK and FAILED are different (spec §8.4): STUCK means "I need you" and the
 * browser is frozen where it is; FAILED means "this is unachievable, move on".
 */
export type ObjectiveResult =
  | { kind: "done"; steps: number; cost: number }
  | { kind: "stuck"; reason: string; steps: number; cost: number }
  | { kind: "failed"; reason: string; steps: number; cost: number };

export interface StepRecord {
  action: Action;
  outcome: StepOutcome;
  /** One-line summary of what changed, for the compacted history (§8.3). */
  effect: string;
}
