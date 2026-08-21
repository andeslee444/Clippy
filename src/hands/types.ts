/** A generation-scoped element reference, e.g. "g3-r12". Only valid within its generation. */
export type Ref = string;

export type Action =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: Ref }
  | { kind: "fill"; ref: Ref; value: string }
  | { kind: "select"; ref: Ref; value: string }
  | { kind: "upload"; ref: Ref; path: string }
  | { kind: "readPage" }
  | { kind: "capturePage" }
  | { kind: "submit"; ref: Ref };

export interface ToolMeta {
  /** Can the effect be undone without contacting anyone? */
  reversible: boolean;
  /** Does this send something to a third party under the user's name? */
  outwardFacing: boolean;
}

/**
 * Static per-tool safety metadata (spec §7.1).
 *
 * These are properties of the TOOL, never of the call. A model is not consulted
 * about them and cannot influence them. Adding a new Action kind without adding
 * a row here is a type error, which is the point.
 */
export const TOOL_META: Record<Action["kind"], ToolMeta> = {
  navigate:    { reversible: true,  outwardFacing: false },
  click:       { reversible: true,  outwardFacing: false },
  fill:        { reversible: true,  outwardFacing: false },
  select:      { reversible: true,  outwardFacing: false },
  upload:      { reversible: true,  outwardFacing: false },
  readPage:    { reversible: true,  outwardFacing: false },
  capturePage: { reversible: true,  outwardFacing: false },
  submit:      { reversible: false, outwardFacing: true  },
};
