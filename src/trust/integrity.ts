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
/**
 * A run of capitalised words, as a candidate entity.
 *
 * The inner word may not end in a full stop. It used to, and the run then
 * swallowed the next sentence's first word: "…using SQL. I built…" tokenised
 * as "SQL. I", and "…reviewing PRs. I built…" as "PRs. I" — two organisations
 * that have never existed, reported against an answer that was entirely true.
 * The lookbehind is on the CONTINUATION, not the word: a trailing dot is
 * consumed happily, but the run cannot carry on past one. Guarding the word
 * instead does nothing, because the dot has already been eaten by the time the
 * check runs.
 *
 * A dot INSIDE a word is kept only when an uppercase letter follows it, which
 * is what separates an initialism from a sentence ending. "B.S." and "L.P."
 * survive whole; "SQL. I" still stops at the full stop. Without this, "My B.S.
 * in Computer Science" reported the organisation "My B." — a flake that failed
 * one run in five.
 */
const CAPRUN =
  /\b[A-Z](?:[a-zA-Z&'-]|\.(?=[A-Z]))*\.?(?:(?<!\.)\s+(?:of|and|the)?\s*[A-Z](?:[a-zA-Z&'-]|\.(?=[A-Z]))*\.?)*/g;

/** Is this match at the start of a sentence? Those are prose, not organisations. */
function sentenceInitial(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/\s+$/, "");
  // A list marker opens a clause exactly as a full stop does. Without this,
  // an answer written in "(a) … (b) …" sections reported "Deal" and "Building"
  // as unverifiable organisations — one violation per section, all noise.
  return (
    before === "" ||
    /[.!?:;]$/.test(before) ||
    /(?:^|\s)(?:\(?[a-z0-9]\)|[-•*]|\d+\.)$/.test(before)
  );
}

const norm = (s: string) => s.toLowerCase().replace(/[.,]$/, "").trim();

/** Whitespace-free form, so "TradingView" and "Trading View" compare equal. */
const squash = (s: string) => s.replace(/\s+/g, "");

/**
 * Spellings of one entity that should all resolve to the same lookup.
 *
 * Every entry NARROWS the tokenizer; none loosens the check. An organisation
 * absent from the profile, the posting, and the allow-list still fails all of
 * them under every variant. The distinction is the whole point: the other way
 * to quieten a noisy validator is to relax what counts as a match, and a
 * fail-closed check that cries wolf eight times per real finding has already
 * failed open no matter what its code says.
 */
/** Words that carry no initial in an acronym: "University *of* Texas *at* Austin". */
const MINOR = new Set(["of", "the", "and", "at", "for", "in", "de", "la"]);

/**
 * Does `candidate` name `org` by acronym?
 *
 * "UT Austin" and "University of Texas at Austin" are the same school, and a
 * résumé writes the first while a profile records the second. Substring
 * matching cannot see it, and neither can squashing.
 *
 * Applied to TITLES as well as organisations — "Lead PM" abbreviates "Lead
 * Product Manager" by exactly the same move, and a check that knew this for
 * employers but not for job titles would flag half of any résumé.
 *
 * Every token of the candidate must be accounted for: either it appears among
 * the organisation's words, or it is a prefix of the organisation's initials.
 * Both halves are required, which is what keeps this narrow — "GX Austin" fails
 * on the first token, and a bare "U" fails the two-character floor.
 */
function acronymOf(candidate: string, org: string): boolean {
  const words = org.split(/\s+/).filter(Boolean);
  const significant = words.filter((w) => !MINOR.has(w));
  if (significant.length < 2) return false;
  const initials = significant.map((w) => w[0] ?? "").join("");

  const tokens = candidate.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // An acronym is the initials of some CONSECUTIVE run of words, not a prefix
  // of every initial in the name. "PM" is Product Manager inside "Lead Product
  // Manager, AI Agents"; a prefix test only ever sees "lpmaa" and misses it.
  const runs = new Set<string>();
  for (let i = 0; i < initials.length; i++) {
    for (let j = i + 2; j <= initials.length; j++) runs.add(initials.slice(i, j));
  }

  return tokens.every((t) => words.includes(t) || (t.length >= 2 && runs.has(t)));
}

function variantsOf(lower: string): string[] {
  const out = new Set<string>([lower]);
  // Possessive: the profile holds "Nasdaq", the sentence says "Nasdaq's".
  // Both apostrophes — resumes carry the curly one, typed prose the straight.
  out.add(lower.replace(/['\u2019]s\b/g, "").trim());
  // A trailing lone "I" is the English pronoun swallowed by the capital run:
  // "at Bloomberg I did credit analysis" tokenises as "Bloomberg I".
  for (const v of [...out]) out.add(v.replace(/\s+i$/, "").trim());
  // A leading preposition or determiner belongs to the sentence, not to the
  // name. A clause opening "On Nasdaq's acquisition…", "As Lead PM…", or
  // "My B.S. in…" capitalises it, and it lands inside the run.
  for (const v of [...out]) {
    out.add(v.replace(/^(?:on|at|as|in|for|with|to|by|from|my|our|their|his|her|its)\s+/, "").trim());
  }
  // Initialisms are written both ways: the profile records "BS", the sentence
  // writes "B.S.". Dots are punctuation here, not identity.
  for (const v of [...out]) out.add(v.replace(/\./g, "").trim());
  return [...out].filter(Boolean);
}

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
export function checkIntegrity(
  text: string,
  facts: ProfileFacts,
  /**
   * Names that are legitimate here despite being absent from the profile —
   * in practice the company being applied to.
   *
   * A cover letter names the employer, and the employer will never be in the
   * candidate's own profile; that is what a profile is. Without this, every
   * tailored answer that mentions the company is rejected, and the pressure
   * becomes to loosen the validator generally — which is how a fail-closed
   * check quietly turns fail-open. Narrow beats lenient.
   */
  alsoKnown: string[] = [],
  /**
   * The job posting's own text.
   *
   * There are TWO kinds of claim here with two different sources of truth, and
   * conflating them is what made this check reject good writing twice:
   *
   *   - Claims about the CANDIDATE — employers, titles, dates, metrics — must
   *     be verifiable against the profile. Fabricating these is the thing §7.4
   *     exists to stop.
   *   - Claims about the EMPLOYER or the ROLE — team names, products,
   *     technologies — are verifiable against the posting. "I am drawn to the
   *     Core Ledger team's event store" is a true sentence about a real team,
   *     and it will never appear in the candidate's profile.
   *
   * This is a rule, not an exemption. A company named in neither source is
   * still rejected, which is what keeps the check fail-closed while two
   * accumulated special cases would not have.
   */
  posting = "",
): IntegrityResult {
  const known = alsoKnown.map((k) => k.toLowerCase());
  const postingText = posting.toLowerCase();
  // Hoisted: squashing per candidate would redo this for every capital run.
  const squashedCorpus = squash(facts.corpus);
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

    // Hyphenated compounds ending in a lowercase suffix are ADJECTIVES, not
    // names: "IB-style", "IB-adjacent", "Hands-on". They describe a thing; they
    // do not name an organisation, and no profile will ever contain them. A
    // hyphen followed by a CAPITAL is the opposite case — "Coca-Cola" and
    // "E-Trade" are names — so the capital is what decides.
    const withoutAdjectives = phrase
      .split(/\s+/)
      .filter((w) => !/^[A-Z][A-Za-z]*-[a-z]/.test(w))
      .join(" ")
      .trim();
    // Nothing but adjectives: there is no entity here to verify.
    if (!withoutAdjectives) continue;

    // A lone capitalised word at the START of a sentence is prose, not an
    // organisation. Mid-sentence it is checked — skipping every single word
    // let "Worked at Globex" through, which is the exact failure this exists
    // to prevent.
    if (words.length === 1 && sentenceInitial(text, match.index)) continue;

    const candidates = new Set([...variantsOf(lower), ...variantsOf(norm(withoutAdjectives))]);
    const recognised = [...candidates].filter(Boolean).some(
      (v) =>
        known.some((k) => v === k || v.includes(k) || k.includes(v)) ||
        (postingText !== "" && postingText.includes(v)) ||
        facts.organisations.some((o) => o === v || v.includes(o) || o.includes(v) || acronymOf(v, o)) ||
        facts.titles.some((t) => t === v || v.includes(t) || t.includes(v) || acronymOf(v, t)) ||
        facts.corpus.includes(v) ||
        // Spacing is not identity: the resume writes "Trading View", the
        // sentence writes "TradingView".
        squashedCorpus.includes(squash(v)),
    );

    if (!recognised) violations.push({ kind: "organisation", value: phrase });
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
