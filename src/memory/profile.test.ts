import { describe, it, expect } from "vitest";
import { ProfileSchema, factsOf, type Profile } from "./profile.js";

const sample: Profile = {
  name: "Andes Lee",
  email: "a@b.c",
  phone: "+1 415 555 0100",
  location: "San Francisco, CA",
  workAuthorized: true,
  needsSponsorship: false,
  salaryExpectation: "$185,000",
  links: { linkedin: "https://linkedin.com/in/x" },
  employers: [
    {
      company: "Acme Corp",
      title: "Senior Engineer",
      start: "2021",
      end: "2024",
      bullets: ["Led the platform migration, cutting p95 latency 40%"],
    },
  ],
  education: [{ school: "State University", degree: "BS Computer Science", end: "2018" }],
  answers: { "why do you want to work here": "" },
};

describe("ProfileSchema", () => {
  it("accepts a complete profile", () => {
    expect(ProfileSchema.parse(sample)).toBeTruthy();
  });

  it("rejects a profile with no employers — nothing could be validated against it", () => {
    expect(() => ProfileSchema.parse({ ...sample, employers: [] })).toThrow();
  });

  it("rejects a missing name", () => {
    const { name, ...rest } = sample;
    expect(() => ProfileSchema.parse(rest)).toThrow();
  });

  it("allows an employer with no end date (current role)", () => {
    const p = { ...sample, employers: [{ ...sample.employers[0]!, end: undefined }] };
    expect(ProfileSchema.parse(p)).toBeTruthy();
  });
});

describe("factsOf", () => {
  it("collects every company, title, school, and degree", () => {
    const f = factsOf(sample);
    expect(f.organisations).toContain("acme corp");
    expect(f.organisations).toContain("state university");
    expect(f.titles).toContain("senior engineer");
  });

  it("collects every year mentioned anywhere", () => {
    expect(factsOf(sample).years).toEqual(new Set(["2018", "2021", "2024"]));
  });

  it("collects metrics from bullet source material", () => {
    expect(factsOf(sample).metrics).toContain("40%");
  });

  it("collects the salary figure as a metric", () => {
    expect(factsOf(sample).metrics).toContain("$185,000");
  });

  it("lowercases organisations and titles for case-insensitive matching", () => {
    expect(factsOf(sample).organisations.every((o) => o === o.toLowerCase())).toBe(true);
  });
});
