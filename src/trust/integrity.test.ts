import { describe, it, expect } from "vitest";
import { checkIntegrity } from "./integrity.js";
import { factsOf, type Profile } from "../memory/profile.js";

const profile: Profile = {
  name: "Andes Lee", email: "a@b.c", phone: "", location: "",
  workAuthorized: true, needsSponsorship: false, salaryExpectation: "$185,000", links: {},
  employers: [{
    company: "Acme Corp", title: "Senior Engineer", start: "2021", end: "2024",
    bullets: ["Led the platform migration, cutting p95 latency 40%"],
  }],
  education: [{ school: "State University", degree: "BS Computer Science", end: "2018" }],
  answers: {}, verifiedFields: [],
};
const facts = factsOf(profile);
const check = (text: string) => checkIntegrity(text, facts);

describe("checkIntegrity — accepts truthful text", () => {
  it("passes a bullet rephrased from real material", () => {
    expect(check("Led a platform migration at Acme Corp that cut p95 latency 40%").ok).toBe(true);
  });

  it("passes text with no checkable claims at all", () => {
    expect(check("I care deeply about building reliable systems.").ok).toBe(true);
  });

  it("passes a real year", () => {
    expect(check("Joined Acme Corp in 2021.").ok).toBe(true);
  });

  it("does not flag common technology names as employers", () => {
    expect(check("Built services in Python and TypeScript on Kubernetes.").ok).toBe(true);
  });

  it("does not flag a sentence-initial verb as an organisation", () => {
    expect(check("Designed the ingestion pipeline. Shipped it in 2024.").ok).toBe(true);
  });
});

describe("checkIntegrity — rejects fabrication", () => {
  it("REJECTS an invented employer", () => {
    const r = check("Senior Engineer at Globex Industries");
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.value)).toContain("Globex Industries");
  });

  it("REJECTS a shifted date", () => {
    const r = check("Worked at Acme Corp from 2019.");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "year" && v.value === "2019")).toBe(true);
  });

  it("REJECTS an inflated metric", () => {
    const r = check("Cut p95 latency 90% at Acme Corp");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "metric" && v.value === "90%")).toBe(true);
  });

  it("REJECTS an invented school", () => {
    expect(check("BS Computer Science, Harvard University").ok).toBe(false);
  });

  it("names every violation, not just the first", () => {
    const r = check("At Globex Industries in 2019 I cut costs 90%");
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it("fails closed on an empty profile fact set", () => {
    const empty = { organisations: [], titles: [], years: new Set<string>(), metrics: [], corpus: "" };
    expect(checkIntegrity("Acme Corp", empty).ok).toBe(false);
  });
});

describe("checkIntegrity — the asymmetry is deliberate", () => {
  it("would rather reject truthful text than accept fabricated text", () => {
    // An unusual capitalised phrase absent from the profile is rejected even
    // though it may be innocent. A redraft costs a few cents; a fabricated
    // employer on a real application cannot be taken back.
    expect(check("Presented at Strange Loop").ok).toBe(false);
  });
});

describe("checkIntegrity — holes found by adversarial probing", () => {
  // Each of these five passed the validator before being patched. Found by
  // attacking it directly rather than by any test in the suite above.
  it("REJECTS a single-word invented employer mid-sentence", () => {
    // Was skipped entirely: the rule "a lone capitalised word is prose" is only
    // true at the start of a sentence.
    expect(check("Worked at Globex").ok).toBe(false);
  });

  it("still accepts a sentence-initial capitalised verb", () => {
    // The other half of that fix — it must not start flagging ordinary prose.
    expect(check("Designed the pipeline. Shipped it in 2024.").ok).toBe(true);
  });

  it("REJECTS an invented bare number", () => {
    // "managed a team of 12" — 12 is not a percentage, multiplier, or currency,
    // so the metric regex missed it while profile.ts's equivalent caught it.
    expect(check("Managed a team of 12").ok).toBe(false);
  });

  it("REJECTS a metric spelled out in words", () => {
    expect(check("Cut latency forty percent").ok).toBe(false);
  });

  it("REJECTS a spelled-out tenure claim", () => {
    expect(check("I have eight years of experience").ok).toBe(false);
  });

  it("does not flag bare number words without a unit", () => {
    // "one of the" must not trip it, or every second sentence is rejected.
    expect(check("One of the services I owned at Acme Corp").ok).toBe(true);
  });

  it("reports a bad year once, not as both a year and a metric", () => {
    const r = check("Joined in 2019");
    expect(r.violations.filter((v) => v.value === "2019")).toHaveLength(1);
  });

  it("KNOWN LIMIT: a lowercase invented employer is not caught", () => {
    // Documented, not fixed. Catching it means checking every lowercase word
    // against the profile, which rejects ordinary prose. Drafted resume text
    // capitalises company names, so this is exploitable by an adversary but not
    // reachable by a careless model.
    expect(check("worked at globex").ok).toBe(true);
  });
});

describe("checkIntegrity — false positives found on live cover-letter text", () => {
  it("does not flag a capitalised contraction as an organisation", () => {
    // "I've" matched CAPRUN because the pattern allows apostrophes, so every
    // cover letter written in the first person was rejected.
    expect(check("I've shipped agent products at Acme Corp").ok).toBe(true);
  });

  it("REJECTS the target company by default", () => {
    // Absent from the profile, so fail-closed is correct until told otherwise.
    expect(check("I want to work at Discord").ok).toBe(false);
  });

  it("accepts the target company when it is passed as known", () => {
    // A cover letter names the employer, and the employer is never in the
    // candidate's own profile. Narrow allowance, not a loosened validator.
    expect(checkIntegrity("I want to work at Discord", facts, ["Discord"]).ok).toBe(true);
  });

  it("accepts a possessive form of the target company", () => {
    expect(checkIntegrity("Discord's safety work is why I applied", facts, ["Discord"]).ok).toBe(true);
  });

  it("still rejects a DIFFERENT company even when one is allowed", () => {
    // The allowance is for the company being applied to, not a blanket pass.
    expect(checkIntegrity("I worked at Globex Industries", facts, ["Discord"]).ok).toBe(false);
  });
});

describe("checkIntegrity — claims about the employer vs the candidate", () => {
  const posting = "Senior PM for the Core Ledger team. You will own our append-only event store at Ledgerline.";

  it("accepts a team name drawn from the posting", () => {
    // Real team, real posting, and it will never be in the candidate's profile.
    expect(checkIntegrity("I'm drawn to the Core Ledger team's event store", facts, [], posting).ok).toBe(true);
  });

  it("REJECTS the same phrase with no posting to vouch for it", () => {
    expect(checkIntegrity("I'm drawn to the Core Ledger team's event store", facts).ok).toBe(false);
  });

  it("still rejects a fabricated EMPLOYER even with a posting", () => {
    // A claim about the candidate's history is checked against the profile,
    // whatever the posting happens to mention.
    expect(checkIntegrity("I was a Director at Goldman Sachs", facts, [], posting).ok).toBe(false);
  });

  it("still rejects a fabricated metric even with a posting", () => {
    expect(checkIntegrity("I cut latency 90% on the Core Ledger", facts, [], posting).ok).toBe(false);
  });
});




/*
 * Regressions from one real application to a real posting. The generated answer
 * was truthful in every particular and the check reported eight violations —
 * all of them artifacts of how the text was cut into entities, none of them a
 * claim. The last test in this block is the one that matters: it pins that the
 * fixes narrowed the TOKENIZER and did not loosen the CHECK.
 */
describe("checkIntegrity — tokenizer artifacts are not fabrication", () => {
  it("accepts a possessive form of a known organisation", () => {
    expect(check("I supported Acme Corp's platform migration.").ok).toBe(true);
  });

  it("accepts a possessive written with a curly apostrophe", () => {
    expect(check("I supported Acme Corp’s platform migration.").ok).toBe(true);
  });

  it("does not absorb the pronoun I into the preceding organisation", () => {
    // Tokenises as "Acme Corp I" — a company that has never existed.
    expect(check("At Acme Corp I led the platform migration.").ok).toBe(true);
  });

  it("treats a lettered list marker as the start of a clause", () => {
    expect(check("(a) Deal workflows: I led a migration. (b) Building: I shipped it.").ok).toBe(true);
  });

  it("ignores spacing differences in an organisation name", () => {
    // The profile says "Acme Corp"; the sentence says "AcmeCorp".
    expect(check("Ran diligence on AcmeCorp during the migration.").ok).toBe(true);
  });

  it("STILL rejects an invented organisation under every variant", () => {
    // The point of the four fixes above is that this line does not move.
    expect(check("I led the migration at Globex.").ok).toBe(false);
    expect(check("I led the migration at Globex's platform team.").ok).toBe(false);
    expect(check("At Globex I led the migration.").ok).toBe(false);
    expect(check("(a) At Globex, I led the migration.").ok).toBe(false);
    expect(check("Ran diligence on GlobexIndustries.").ok).toBe(false);
  });
});

describe("checkIntegrity — runs stop at sentence and clause boundaries", () => {
  it("does not join a sentence-final word to the next sentence", () => {
    // "…using SQL. I built…" tokenised as "SQL. I" — an organisation that has
    // never existed, reported against an answer true in every particular.
    expect(check("I used SQL. I led the migration at Acme Corp.").ok).toBe(true);
  });

  it("flags the abbreviation itself, not the abbreviation plus the next clause", () => {
    // "PRs" is genuinely unknown and stays flagged — that is fail-closed
    // working. What must not survive is the JOINED form, which named a thing
    // no sentence in the text ever referred to.
    const result = check("I reviewed PRs. I shipped the migration.");
    expect(result.violations.map((v) => v.value)).not.toContain("PRs. I");
  });

  it("keeps a real trailing initialism together", () => {
    // The fix must not split "Bloomberg L.P." into something unrecognisable.
    expect(check("Worked at Bloomberg L.P. on credit analysis.").ok).toBe(false);
  });

  it("does not treat a leading preposition as part of the name", () => {
    expect(check("On Acme Corp's migration I led the platform work.").ok).toBe(true);
    expect(check("As Senior Engineer I led the platform migration.").ok).toBe(true);
  });

  it("STILL rejects an invented organisation behind a preposition", () => {
    expect(check("On Globex's migration I led the platform work.").ok).toBe(false);
    expect(check("I used SQL. I led the migration at Globex.").ok).toBe(false);
  });
});

describe("checkIntegrity — an organisation named by its acronym", () => {
  const acronymFacts = factsOf({
    name: "A", email: "a@b.c", phone: "", location: "",
    workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
    employers: [{ company: "Acme Corp", title: "Engineer", start: "2021", end: "2024", bullets: [] }],
    education: [{ school: "University of Texas at Austin", degree: "BS Computer Science", end: "2017" }],
    answers: {}, verifiedFields: [],
  });
  const ac = (t: string) => checkIntegrity(t, acronymFacts);

  it("accepts the acronym a résumé actually uses", () => {
    // The profile records the full name; nobody writes it out in prose.
    expect(ac("I have a B.S. in Computer Science from UT Austin.").ok).toBe(true);
  });

  it("STILL rejects an acronym that expands to nothing on file", () => {
    expect(ac("I have a B.S. in Computer Science from GX Austin.").ok).toBe(false);
    expect(ac("I studied at MIT Austin.").ok).toBe(false);
  });

  it("does not let a single letter match anything", () => {
    expect(ac("I worked at U Systems.").ok).toBe(false);
  });
});

describe("checkIntegrity — initialisms and sentence-opening determiners", () => {
  const degreeFacts = factsOf({
    name: "A", email: "a@b.c", phone: "", location: "",
    workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
    employers: [{ company: "Bloomberg L.P.", title: "Analyst", start: "2019", end: "2021", bullets: [] }],
    education: [{ school: "University of Texas at Austin", degree: "BS Computer Science", end: "2017" }],
    answers: {}, verifiedFields: [],
  });
  const d = (t: string) => checkIntegrity(t, degreeFacts);

  it("does not split an initialism across the sentence", () => {
    // Tokenised as "My B." — an organisation nothing in the text refers to.
    // Failed exactly one eval run in five, which is how flakes look.
    expect(d("My B.S. in Computer Science grounds the technical conversations.").ok).toBe(true);
  });

  it("matches a dotted initialism against the profile's undotted one", () => {
    expect(d("I hold a B.S. in Computer Science.").ok).toBe(true);
  });

  it("keeps a company's own initialism together", () => {
    expect(d("I worked at Bloomberg L.P. on credit analysis.").ok).toBe(true);
  });

  it("STILL stops a run at a real sentence boundary", () => {
    // Globex must be MID-sentence: a lone capitalised word opening a sentence
    // is skipped as prose by design, so putting it first would test the skip
    // rather than the boundary.
    const values = d("I used SQL. I then joined Globex in 2019.").violations.map((v) => v.value);
    expect(values).toContain("Globex");
    // And the run did not drag the full stop along with it.
    expect(values.some((v) => v.includes("SQL"))).toBe(false);
  });

  it("STILL rejects an invented organisation behind a determiner", () => {
    expect(d("My Globex Industries role taught me a lot.").ok).toBe(false);
  });
});

describe("checkIntegrity — compound adjectives are not organisations", () => {
  const f = factsOf({
    name: "A", email: "a@b.c", phone: "", location: "",
    workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
    employers: [{ company: "Acme Corp", title: "Lead Product Manager, AI Agents", start: "2021", end: "2024", bullets: [] }],
    education: [], answers: {}, verifiedFields: [],
  });
  const c = (t: string) => checkIntegrity(t, f);

  it("does not read a hyphenated adjective as a company", () => {
    // "IB-style" and "Hands-on" describe a thing; they do not name one, and no
    // profile will ever contain them.
    expect(c("I did IB-style diligence work at Acme Corp.").ok).toBe(true);
    expect(c("Hands-on AI work has been my focus at Acme Corp.").ok).toBe(true);
  });

  it("still treats a hyphenated NAME as a name", () => {
    // The capital after the hyphen is what separates Coca-Cola from IB-style.
    expect(c("I worked at Coca-Cola on the platform.").ok).toBe(false);
  });

  it("matches a title acronym against consecutive words", () => {
    // "PM" is Product Manager inside "Lead Product Manager, AI Agents".
    expect(c("As Lead PM I owned the roadmap.").ok).toBe(true);
  });

  it("STILL rejects an invented company beside an adjective", () => {
    expect(c("I did IB-style work at Globex Industries.").ok).toBe(false);
  });

  it("STILL rejects an acronym matching no consecutive run", () => {
    expect(c("As Lead XQ I owned the roadmap.").ok).toBe(false);
  });
});

describe("checkIntegrity — leading function words", () => {
  it("strips a whole run of them, not just one", () => {
    // "If the Core Ledger team…" tokenised as the organisation
    // "If the Core Ledger". Two leading function words, so stripping one was
    // not enough — which is why this is a loop over the stoplist rather than
    // an alternation of the words seen so far.
    const posting = "You will join the Core Ledger team building append-only systems.";
    const r = checkIntegrity("If the Core Ledger team would have me, I would be glad to talk.", facts, [], posting);
    expect(r.violations.map((v) => v.value)).not.toContain("If the Core Ledger");
  });

  it("STILL rejects an invented name behind function words", () => {
    expect(checkIntegrity("If the Globex Industries team would have me.", facts, [], "").ok).toBe(false);
  });

  it("never strips away the last word", () => {
    // "The" alone must not become an empty candidate that matches everything.
    expect(checkIntegrity("I then joined Globex.", facts, [], "").ok).toBe(false);
  });
});
