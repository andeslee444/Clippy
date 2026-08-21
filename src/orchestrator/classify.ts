import { StaleRefError, SubmitCapableError } from "../hands/browser/act.js";
import { ApprovalDeniedError } from "../hands/execute.js";
import type { StepOutcome } from "./types.js";

/** Page conditions only a human can clear (spec §7.5, §8.4). */
const NEEDS_HUMAN = /captcha|recaptcha|hcaptcha|sign in|log ?in required|login required|verify you are human/i;

/**
 * Map a thrown error to how the step should be accounted (spec §8.4).
 *
 * The distinction that matters is `retry-free` vs `retry`. A stale ref means the
 * page re-rendered between observe and act, so NOTHING executed — charging it
 * would let a re-render storm eat an objective's budget without work happening.
 * Every other retry represents a real attempt and is charged.
 */
export function classify(err: unknown): StepOutcome {
  if (err instanceof StaleRefError) {
    return { kind: "retry-free", reason: err.message };
  }
  if (err instanceof ApprovalDeniedError) {
    return { kind: "stuck", reason: `approval denied for ${err.effect.kind}` };
  }
  if (err instanceof SubmitCapableError) {
    // The model called a submit a click. Correctable — tell it and charge it.
    return { kind: "retry", reason: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);
  if (NEEDS_HUMAN.test(message)) {
    return { kind: "stuck", reason: message };
  }
  return { kind: "retry", reason: message };
}
