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
  const meta = EFFECT_META[effect.kind];

  // Static floor. Anything outward-facing or irreversible always gates,
  // regardless of what the page looks like.
  if (meta.outwardFacing || !meta.reversible) return true;

  if (!facts) return false;

  // The DOM says activating this element submits a form. Gate it whatever the
  // model chose to call the action — the kind is model-supplied, this is not.
  if (facts.submitCapable) return true;

  // No <form> on the page, so submitCapable could not have detected anything.
  // Rather than read "not flagged" as "safe", gate every click. Costs friction
  // on form-less SPAs (Workday); the alternative is a silent hole on one of the
  // three major ATS platforms.
  // A click on an element OUTSIDE any form. `submitCapable` cannot speak for it
  // — a <button> outside a form is never flagged however it is wired — so the
  // absence of evidence is not evidence of safety, and it gates.
  if (!facts.formAssociated && effect.kind === "click") return true;

  return false;
}
