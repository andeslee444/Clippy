import type { ProfileFacts } from "../memory/profile.js";
import { STOPLIST } from "./stoplist.js";

export interface Violation {
  kind: "organisation" | "year" | "metric";
  value: string;
}

export interface IntegrityResult {
  ok: boolean;
  violations: Violation[];
}

const YEAR = /\b(?:19|20)\d{2}\b/g;
const METRIC = /\$[\d,]+(?:\.\d+)?[KMB]?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?x\b/g;
/** Runs of capitalised words — the shape an organisation name takes. */
const CAPRUN = /\b[A-Z][a-zA-Z&.'-]*(?:\s+(?:of|and|the)?\s*[A-Z][a-zA-Z&.'-]*)*/g;

const norm = (s: string) => s.toLowerCase().replace(/[.,]$/, "").trim();

/**
 * Verify that every checkable claim in `text` appears in the profile (spec §7.4).
 *
 * FAILS CLOSED. Anything claim-shaped that cannot be found is a violation, which
 * means truthful-but-unusual text is sometimes rejected. That asymmetry is
 * intentional: a rejection costs a redraft, while a fabricated employer on a
 * real application sent under the user's name cannot be retracted.
 *
 * It cannot catch reworded seniority, invented scope described without numbers,
 * or a real metric attached to the wrong job. Those are what the human review at
 * §9.5 is for — which is why that dialog groups by provenance.
 */
export function checkIntegrity(text: string, facts: ProfileFacts): IntegrityResult {
  const violations: Violation[] = [];

  for (const year of text.match(YEAR) ?? []) {
    if (!facts.years.has(year)) violations.push({ kind: "year", value: year });
  }

  for (const metric of text.match(METRIC) ?? []) {
    const found = facts.metrics.some((m) => norm(m) === norm(metric)) ||
      facts.corpus.includes(norm(metric));
    if (!found) violations.push({ kind: "metric", value: metric });
  }

  for (const raw of text.match(CAPRUN) ?? []) {
    const phrase = raw.trim();
    const lower = norm(phrase);
    if (!lower) continue;

    // A single stoplisted word, or a run made entirely of stoplisted words.
    const words = lower.split(/\s+/);
    if (words.every((w) => STOPLIST.has(w))) continue;
    // A lone capitalised word is usually sentence-initial prose, not an org.
    if (words.length === 1) continue;

    const known =
      facts.organisations.some((o) => o === lower || lower.includes(o) || o.includes(lower)) ||
      facts.titles.some((t) => t === lower || lower.includes(t) || t.includes(lower)) ||
      facts.corpus.includes(lower);

    if (!known) violations.push({ kind: "organisation", value: phrase });
  }

  return { ok: violations.length === 0, violations };
}

/** Render violations for a human or for a redraft instruction to the model. */
export function explain(result: IntegrityResult): string {
  if (result.ok) return "ok";
  return result.violations
    .map((v) => `${v.kind} "${v.value}" does not appear in your profile`)
    .join("; ");
}
