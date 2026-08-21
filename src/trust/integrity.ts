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

/**
 * Numeric claims. The trailing `\b\d{2,}\b` matters: without it "managed a team
 * of 12" sailed through, because 12 is neither a percentage, a multiplier, nor a
 * currency amount. It must stay in step with METRIC in profile.ts — an
 * adversarial probe found them diverged, so the validator was checking a
 * narrower set of tokens than the profile had collected.
 */
const METRIC = /\$[\d,]+(?:\.\d+)?[KMB]?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?x\b|\b\d{2,}\b/g;

/**
 * Spelled-out numeric claims — "cut latency forty percent", "eight years of
 * experience". The digit regexes miss these entirely.
 *
 * A unit is REQUIRED. Matching bare number words would flag "one of the systems"
 * in every second sentence, and a validator that rejects everything gets
 * switched off.
 */
const NUMBER_WORD = new RegExp(
  "\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|" +
    "thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|" +
    "hundred|thousand|million|billion)\\s+" +
    "(?:percent|years?|months?|weeks?|times|fold|people|engineers?|reports?|" +
    "users?|customers?|clients?|million|billion)\\b",
  "gi",
);

/** Runs of capitalised words — the shape an organisation name takes. */
const CAPRUN = /\b[A-Z][a-zA-Z&.'-]*(?:\s+(?:of|and|the)?\s*[A-Z][a-zA-Z&.'-]*)*/g;

/** Is this match at the start of a sentence? Those are prose, not organisations. */
function sentenceInitial(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/\s+$/, "");
  return before === "" || /[.!?:;]$/.test(before);
}

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
 *
 * It also cannot catch a LOWERCASE invented organisation ("worked at globex").
 * Detecting those would mean checking every lowercase word against the profile,
 * which rejects ordinary prose and makes the validator unusable. Accepted as a
 * known limit: drafted resume text capitalises company names, so this is a gap
 * an adversary could exploit but a careless model will not fall into.
 */
export function checkIntegrity(text: string, facts: ProfileFacts): IntegrityResult {
  const violations: Violation[] = [];

  for (const year of text.match(YEAR) ?? []) {
    if (!facts.years.has(year)) violations.push({ kind: "year", value: year });
  }

  const reportedYears = new Set(violations.map((v) => v.value));
  for (const metric of [...(text.match(METRIC) ?? []), ...(text.match(NUMBER_WORD) ?? [])]) {
    // A four-digit year also matches the bare-number branch. Report it once, as
    // a year — "metric 2019 is unfounded" alongside "year 2019 is unfounded"
    // reads like two problems when it is one.
    if (reportedYears.has(metric)) continue;
    const found = facts.metrics.some((m) => norm(m) === norm(metric)) ||
      facts.corpus.includes(norm(metric));
    if (!found) violations.push({ kind: "metric", value: metric });
  }

  for (const match of text.matchAll(CAPRUN)) {
    const phrase = match[0].trim();
    const lower = norm(phrase);
    if (!lower) continue;

    // A run made entirely of stoplisted words.
    const words = lower.split(/\s+/);
    if (words.every((w) => STOPLIST.has(w))) continue;

    // A lone capitalised word at the START of a sentence is prose, not an
    // organisation. Mid-sentence it is checked — skipping every single word
    // let "Worked at Globex" through, which is the exact failure this exists
    // to prevent.
    if (words.length === 1 && sentenceInitial(text, match.index)) continue;

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
