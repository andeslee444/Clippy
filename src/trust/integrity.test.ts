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
