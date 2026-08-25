import { describe, it, expect } from "vitest";
import { titleCaseName, profileWarnings } from "./normalise.js";
import type { Profile } from "./profile.js";

const base: Profile = {
  name: "A", email: "a@b.c", phone: "", location: "",
  workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
  employers: [{ company: "Acme", title: "PM", start: "2020", bullets: [] }],
  education: [], answers: {},
};

describe("titleCaseName", () => {
  it("fixes an all-caps resume header", () => {
    expect(titleCaseName("ANDES H. LEE")).toBe("Andes H. Lee");
  });

  it("keeps single-letter initials intact", () => {
    expect(titleCaseName("J. R. R. TOLKIEN")).toBe("J. R. R. Tolkien");
  });

  it("leaves an already mixed-case name alone", () => {
    // "McTestface" and "de Silva" are deliberate, not shouting.
    expect(titleCaseName("Jane McTestface")).toBe("Jane McTestface");
    expect(titleCaseName("Ana de Silva")).toBe("Ana de Silva");
  });

  it("handles hyphenated surnames", () => {
    expect(titleCaseName("MARIA GARCIA-LOPEZ")).toBe("Maria Garcia-Lopez");
  });
});

describe("profileWarnings", () => {
  it("flags a blank salary", () => {
    expect(profileWarnings(base).map((w) => w.field)).toContain("salaryExpectation");
  });

  it("ALWAYS flags work authorisation, even when it looks fine", () => {
    // It is defaulted by ingestion, never extracted — so "authorised, no
    // sponsorship" is an unverified claim about immigration status, not a fact.
    const filled = { ...base, salaryExpectation: "$1", phone: "1", location: "NY", links: { x: "y" } };
    expect(profileWarnings(filled).map((w) => w.field)).toEqual(["workAuthorized / needsSponsorship"]);
  });

  it("says what the current value is, so it can be confirmed or corrected", () => {
    const w = profileWarnings(base).find((w) => w.field.startsWith("workAuthorized"))!;
    expect(w.why).toMatch(/authorised/);
    expect(w.why).toMatch(/does not need sponsorship/);
  });
});
