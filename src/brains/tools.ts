import { classify } from "../orchestrator/classify.js";
import { provenanceOf } from "./provenance.js";
import type { ProfileFacts } from "../memory/profile.js";
import type { StepRecord } from "../orchestrator/types.js";
import type { Effect } from "../hands/types.js";
import type { BrainTools } from "./types.js";

export interface ToolDeps {
  runEffect: (effect: Effect) => Promise<void>;
  /**
   * The profile, if one is loaded. Used to DERIVE each value's provenance for
   * the §9.5 gate — never asked of the model, which could be wrong about it.
   * Absent means every value shows as `unknown`, which is the honest default.
   */
  facts?: ProfileFacts;
  /**
   * Path to the user's résumé, from the loaded profile. Absent means
   * `attach_resume` refuses rather than guessing at a file.
   *
   * A FUNCTION, not a string, and that is the whole point. The CLI loads the
   * profile lazily — it is still null when makeTools runs — so a snapshot
   * captured `undefined` and kept it for the life of the process, and the model
   * was told there was no résumé on file while one sat in the profile. `ingest`
   * mid-session would have gone stale the same way. Read it when it is needed,
   * not when the tools are built.
   */
  resumePath?: () => string | undefined;
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

    async attachResume(ref: string): Promise<string> {
      const path = deps.resumePath?.();
      if (!path) {
        return "ERROR: no résumé on file — run `ingest <path>` first, or ask the person to attach it.";
      }
      // Routed through perform() so it is recorded, gated, and provenance-
      // stamped like any other effect. A quiet side channel to the executor is
      // how an action ends up outside the audit log.
      return await this.perform({ kind: "upload", ref, path });
    },

    async perform(raw: Effect): Promise<string> {
      // Stamp provenance BEFORE executing, so the record the gate reads is the
      // record of what actually ran.
      // A declared `human` provenance is preserved; anything else is ignored and
      // re-derived. That asymmetry is the point: a person typing a value IS the
      // authority on where it came from, while a model asserting its own output
      // is trustworthy is exactly the hole §7.1 closed. There is no code path by
      // which a model can mark its own text as `profile`.
      const effect: Effect =
        (raw.kind === "fill" || raw.kind === "select") && deps.facts
          ? {
              ...raw,
              provenance: raw.provenance === "human" ? "human" : provenanceOf(raw.value, deps.facts),
            }
          : raw;
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
