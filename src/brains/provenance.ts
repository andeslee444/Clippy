import type { ProfileFacts } from "../memory/profile.js";
import type { Provenance } from "../hands/types.js";

/** Values shorter than this match too much of any corpus to be evidence. */
const MIN_MATCH = 3;

/**
 * Decide where a filled value came from (spec §9.5).
 *
 * DERIVED, never declared. The obvious design is a `source` argument on the fill
 * tool — and it repeats the mistake §7.1 already caught: anything the model
 * asserts about its own output can be wrong, and a fabricated bullet labelled
 * "from profile" would be collapsed into the trusted group, which is precisely
 * the failure the gate exists to prevent.
 *
 * A model cannot lie about whether a string is in a file. So: present in the
 * profile means `profile`, absent means `generated`.
 *
 * Very short values are treated as generated. "NY" or "3" appears in almost any
 * corpus by accident, and a false `profile` is the dangerous direction — it
 * hides a value instead of showing it.
 */
export function provenanceOf(value: string, facts: ProfileFacts): Provenance {
  const v = value.trim().toLowerCase();
  if (v.length < MIN_MATCH) return "generated";
  return facts.corpus.includes(v) ? "profile" : "generated";
}
