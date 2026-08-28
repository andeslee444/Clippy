/** A generation-scoped element reference, e.g. "g3-r12". Only valid within its generation. */
export type Ref = string;

/**
 * Where a filled value came from (spec §9.5).
 *
 * The Submit gate groups by this rather than by form order, because that is
 * where the risk actually sits: a wrong email is a typo, a wrong resume bullet
 * is a false claim on a real application. Grouping by form structure buries the
 * two dangerous fields among sixteen boring ones and trains you to skim.
 *
 * `human` exists because editing a generated value at the gate PROMOTES it —
 * once you have written it, it is no longer something a model asserted.
 */
export type Provenance = "profile" | "generated" | "human";

/** Changes the world. Returns nothing. Can be gated. */
export type Effect =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: Ref }
  | { kind: "fill"; ref: Ref; value: string; provenance?: Provenance }
  | { kind: "select"; ref: Ref; value: string; provenance?: Provenance }
  | { kind: "upload"; ref: Ref; path: string }
  | { kind: "submit"; ref: Ref };

/** Changes nothing. Returns data. Never gated — see §7.3. */
export type Observation =
  | { kind: "readPage" }
  | { kind: "capturePage" };

/** Union used only for audit-log typing, where both are recorded. */
export type Action = Effect | Observation;

export interface ToolMeta {
  /** Can the effect be undone without contacting anyone? */
  reversible: boolean;
  /** Does this send something to a third party under the user's name? */
  outwardFacing: boolean;
}

/**
 * Properties derived from the RESOLVED DOM element, not from the model (§7.1).
 *
 * The model chooses the action kind, so the kind alone cannot be trusted to
 * distinguish a harmless click from a submit. These come from the page.
 */
export interface ElementFacts {
  /** Activating this element submits a form. Derived from the DOM. */
  submitCapable: boolean;
  /**
   * This element sits inside a `<form>`, so `submitCapable` can speak for it.
   *
   * When false, `submitCapable` is not evidence of anything: a `<button>` outside
   * a form is never flagged, whatever it does. §7.1 names this `formAssociated`
   * and it is deliberately ELEMENT-scoped.
   *
   * It was page-scoped ("the page contains no form at all"), reasoned from a
   * Workday page with zero forms. That reasoning holds for a page with no forms
   * and a page that is all form, and fails for the mixed case in between —
   * which is the common one. A footer newsletter `<form>` makes the page
   * form-ful, so the page-level flag reads false; an application submit button
   * rendered outside that form is not `closest("form")`, so `submitCapable`
   * reads false too. Both gate clauses miss and the click goes through ungated.
   *
   * Verified on a live Ashby posting, where "Submit Application" is exactly this
   * shape and only the accident of Ashby having NO form anywhere kept it gated.
   */
  formAssociated: boolean;
}

/**
 * Static per-effect safety metadata (spec §7.1).
 *
 * The floor, not the ceiling: element-derived facts can only ADD gating.
 * Observations are absent by construction — they cannot be gated because they
 * cannot be irreversible.
 *
 * `upload` is outward-facing: many ATS platforms XHR-upload the file the moment
 * it is attached, before any submit. It is not reversible in any useful sense.
 */
export const EFFECT_META: Record<Effect["kind"], ToolMeta> = {
  navigate: { reversible: true,  outwardFacing: false },
  click:    { reversible: true,  outwardFacing: false },
  fill:     { reversible: true,  outwardFacing: false },
  select:   { reversible: true,  outwardFacing: false },
  upload:   { reversible: false, outwardFacing: true  },
  submit:   { reversible: false, outwardFacing: true  },
};
