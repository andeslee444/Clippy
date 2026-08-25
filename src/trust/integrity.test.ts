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
  answers: {},
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



