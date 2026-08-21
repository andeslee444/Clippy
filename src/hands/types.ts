/** A generation-scoped element reference, e.g. "g3-r12". Only valid within its generation. */
export type Ref = string;

/** Changes the world. Returns nothing. Can be gated. */
export type Effect =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: Ref }
  | { kind: "fill"; ref: Ref; value: string }
  | { kind: "select"; ref: Ref; value: string }
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
   * The page contains no `<form>` at all, so `submitCapable` is unreliable here.
   *
   * Measured against a real Workday job page: zero `<form>` elements, everything
   * driven by click handlers. `closest("form")` returns null for every element,
   * so nothing is flagged — including the real submit button. Page-level rather
   * than element-level, but it conditions how far `submitCapable` can be trusted,
   * so it travels with it.
   */
  formless: boolean;
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
