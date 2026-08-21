import type { Objective, ObjectiveResult, StepRecord } from "../orchestrator/types.js";
import type { Effect } from "../hands/types.js";

/** What a brain can ask the world to do. Implemented over GatedExecutor. */
export interface BrainTools {
  readPage(): Promise<string>;
  capturePage(): Promise<{ base64: string }>;
  perform(effect: Effect): Promise<string>;
  /**
   * Every step taken this objective, oldest first.
   *
   * Lives here rather than inside the brain because `perform()` is what learns
   * each outcome. A brain that kept its own array would compact an empty
   * history and never see a `stuck` step — the array would be written by the
   * tools and read by nobody.
   */
  readonly steps: StepRecord[];
}

/**
 * Drives one objective to a terminal state.
 *
 * The seam exists so the orchestrator's behaviour can be tested with a scripted
 * implementation — there is no ANTHROPIC_API_KEY in this environment, and a
 * design that can only be exercised with one is a design that goes untested.
 */
export interface ActBrain {
  pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult>;
}
