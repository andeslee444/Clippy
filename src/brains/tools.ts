import { classify } from "../orchestrator/classify.js";
import type { StepRecord } from "../orchestrator/types.js";
import type { Effect } from "../hands/types.js";
import type { BrainTools } from "./types.js";

export interface ToolDeps {
  runEffect: (effect: Effect) => Promise<void>;
  readPage: () => Promise<string>;
  capturePage: () => Promise<{ base64: string }>;
  onStep: (record: StepRecord) => void;
}

/**
 * Wrap the executor as tools a brain can call.
 *
 * Errors become tool RESULTS rather than exceptions. The SDK's tool runner feeds
 * a result string back to the model, so a denial or a stale ref becomes
 * information it can act on — the documented human-in-the-loop pattern. Throwing
 * would abort the whole run over a recoverable step.
 */
export function makeTools(deps: ToolDeps): BrainTools {
  const steps: StepRecord[] = [];
  const record = (r: StepRecord) => { steps.push(r); deps.onStep(r); };

  return {
    steps,
    readPage: deps.readPage,
    capturePage: deps.capturePage,

    async perform(effect: Effect): Promise<string> {
      try {
        await deps.runEffect(effect);
        const effectText = `${effect.kind} ok`;
        record({ action: effect, outcome: { kind: "ok" }, effect: effectText });
        return `ok — ${effectText}`;
      } catch (err) {
        const outcome = classify(err);
        record({ action: effect, outcome, effect: "" });

        switch (outcome.kind) {
          case "stuck":
            return `DECLINED: ${outcome.reason}. Do not retry this. Stop and explain what you were trying to do.`;
          case "retry-free":
            return `STALE: ${outcome.reason} Read the page again to get fresh refs, then re-observe before acting.`;
          case "retry":
          case "failed":
            return `ERROR: ${outcome.reason}`;
          case "ok":
            // classify() is only ever called from a catch block, so it never
            // actually produces "ok" — but its declared return type is the full
            // StepOutcome union, so this branch exists for exhaustiveness.
            return "ERROR: unexpected ok outcome from classify()";
        }
      }
    },
  };
}
