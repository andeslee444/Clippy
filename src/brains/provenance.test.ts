import { describe, it, expect } from "vitest";
import { provenanceOf } from "./provenance.js";
import { factsOf, type Profile } from "../memory/profile.js";

const profile: Profile = {
  name: "Andes Lee", email: "andes@example.com", phone: "425.533.6828",
  location: "New York, NY", workAuthorized: true, needsSponsorship: false,
  salaryExpectation: "$185,000", links: {},
  employers: [{ company: "Acme Corp", title: "Senior Engineer", start: "2021", end: "2024",
    bullets: ["Led the platform migration, cutting p95 latency 40%"] }],
  education: [], answers: {},
};
const facts = factsOf(profile);
const p = (v: string) => provenanceOf(v, facts);

describe("provenanceOf", () => {
  it("marks a value copied from the profile as profile", () => {
    expect(p("Andes Lee")).toBe("profile");
    expect(p("andes@example.com")).toBe("profile");
    expect(p("$185,000")).toBe("profile");
  });

  it("marks a value the model wrote as generated", () => {
    expect(p("I have long admired your work on distributed systems")).toBe("generated");
  });

  it("marks a REPHRASED bullet as generated even though its facts are real", () => {
    // The facts survive §7.4's check; the sentence is still the model's writing
    // and the human should see it.
    expect(p("Drove a platform migration that cut p95 latency by 40%")).toBe("generated");
  });

  it("is case-insensitive", () => {
    expect(p("ANDES LEE")).toBe("profile");
  });

  it("ignores surrounding whitespace", () => {
    expect(p("  Andes Lee  ")).toBe("profile");
  });

  it("treats a very short value as generated, not profile", () => {
    // "NY" occurs in almost any corpus by accident. A false `profile` hides a
    // value from review, which is the dangerous direction.
    expect(p("NY")).toBe("generated");
    expect(p("3")).toBe("generated");
  });

  it("cannot be talked into `profile` by the model", () => {
    // There is no argument to pass. The only input is the string itself.
    expect(p("Senior Director at Goldman Sachs")).toBe("generated");
  });
});
