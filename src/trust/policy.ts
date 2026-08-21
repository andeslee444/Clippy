import { EFFECT_META, type Effect, type ElementFacts } from "../hands/types.js";

/**
 * The safety boundary (spec §7.1).
 *
 * Returns true if `effect` must not execute until a human has approved it.
 *
 * Pure. Never consults a model, the page, or run state. `facts` are derived from
 * the RESOLVED DOM element by the page script — not supplied by the model — and
 * can only ever ADD gating on top of the static table.
 *
 * TODO(author): implement. See Plan 1a, Task A3 for the trade-offs.
 */
export function isGated(effect: Effect, facts?: ElementFacts): boolean {
  void EFFECT_META;
  void effect;
  void facts;
  throw new Error("isGated not implemented — see docs/superpowers/plans, Plan 1a Task A3");
}
