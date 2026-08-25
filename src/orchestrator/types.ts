import type { Action } from "../hands/types.js";

export interface Objective {
  /** What the user asked for, in words. */
  goal: string;
  /**
   * Facts the model may use, rendered as text — normally the user's profile.
   *
   * Without this the system prompt's "fill only fields you have been given
   * values for" is trivially satisfied by doing nothing, which is exactly what
   * happened on a live Discord posting: 24 fields present, zero filled, run
   * reported done. The model was obeying instructions it had no way to act on.
   */
  context?: string;
  /**
   * Offer only observation tools — no fill, click, select, or submit.
   *
   * For "is this worth applying to?", where acting is not just unnecessary but
   * harmful: a stray click navigates off the posting and the model has no
   * `navigate` tool to get back, so it strands itself. Asking politely in the
   * prompt is not enough — §7.1 established that instructions are advisory. A
   * tool absent from the schema cannot be called however the model is feeling.
   */
  readOnly?: boolean;
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
  /**
   * `message` is the model's closing text. For an acting run it is a summary;
   * for a triage run ("is this worth applying to?") it is the ENTIRE product —
   * discarding it made a working flow indistinguishable from one that did
   * nothing, since both reported done with 0 steps.
   */
  | { kind: "done"; steps: number; cost: number; message?: string }
  | { kind: "stuck"; reason: string; steps: number; cost: number }
  | { kind: "failed"; reason: string; steps: number; cost: number };

export interface StepRecord {
  action: Action;
  outcome: StepOutcome;
  /** One-line summary of what changed, for the compacted history (§8.3). */
  effect: string;
}
