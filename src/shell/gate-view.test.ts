import { describe, it, expect } from "vitest";
import { buildGateView } from "./gate-view.js";
import type { StepRecord } from "../orchestrator/types.js";
import { factsOf } from "../memory/profile.js";

const filled = (name: string, value: string, provenance?: "profile" | "generated" | "human"): StepRecord => ({
  action: { kind: "fill", ref: "g1-r1", value, ...(provenance ? { provenance } : {}) },
  outcome: { kind: "ok" },
  effect: name,
});

const steps: StepRecord[] = [
  filled("First Name*", "Andes", "profile"),
  filled("Email*", "a@b.c", "profile"),
  filled("Why this role?", "I have followed your work on…", "generated"),
  filled("Phone", "555", "profile"),
];

describe("buildGateView", () => {
  it("puts generated values first — they are what can hurt you", () => {
    expect(buildGateView(steps, undefined).groups[0]!.provenance).toBe("generated");
  });

  it("expands the generated group and collapses the rest", () => {
    const v = buildGateView(steps, undefined);
    expect(v.groups.find((g) => g.provenance === "generated")!.expanded).toBe(true);
    expect(v.groups.find((g) => g.provenance === "profile")!.expanded).toBe(false);
  });

  it("counts each group", () => {
    const v = buildGateView(steps, undefined);
    expect(v.groups.find((g) => g.provenance === "profile")!.items).toHaveLength(3);
    expect(v.groups.find((g) => g.provenance === "generated")!.items).toHaveLength(1);
  });

  it("omits a group with no members rather than showing an empty one", () => {
    expect(buildGateView([filled("Name", "x", "profile")], undefined).groups.map((g) => g.provenance))
      .toEqual(["profile"]);
  });

  it("treats an unmarked value as unknown, never as trusted", () => {
    // A value with no provenance has NOT been shown to come from the profile.
    // Defaulting it to `profile` would hide exactly the case worth seeing.
    const v = buildGateView([filled("Mystery", "x")], undefined);
    expect(v.groups[0]!.provenance).toBe("unknown");
  });

  it("sorts unknown alongside generated, ahead of profile", () => {
    const v = buildGateView([filled("A", "x", "profile"), filled("B", "y")], undefined);
    expect(v.groups[0]!.provenance).toBe("unknown");
  });

  it("ignores steps that are not fills", () => {
    const withClick: StepRecord[] = [
      ...steps,
      { action: { kind: "click", ref: "g1-r9" }, outcome: { kind: "ok" }, effect: "clicked" },
    ];
    expect(buildGateView(withClick, undefined).total).toBe(4);
  });

  it("reports the total so the dialog can say 'reviewing 3 of 18'", () => {
    const v = buildGateView(steps, undefined);
    expect(v.total).toBe(4);
    expect(v.needsReview).toBe(1);
  });
});

describe("buildGateView — edit support", () => {
  it("carries the ref so an edit can re-fill that exact element", () => {
    const v = buildGateView([filled("Why this role?", "text", "generated")], undefined);
    expect(v.groups[0]!.items[0]!.ref).toBe("g1-r1");
  });

  it("marks human-edited values as their own group, ahead of profile", () => {
    const v = buildGateView([
      filled("Name", "Andes", "profile"),
      filled("Why this role?", "I rewrote this myself", "human"),
    ], undefined);
    expect(v.groups.map((g) => g.provenance)).toEqual(["human", "profile"]);
  });

  it("does not ask for review of a value the human wrote", () => {
    // They just wrote it. Asking them to vet their own sentence is noise.
    const v = buildGateView([filled("Why this role?", "mine", "human")], undefined);
    expect(v.needsReview).toBe(0);
  });
});


/*
 * The gap this covers: checkIntegrity existed, was tested, and the renderer had
 * a warning line ready for its output — and on the path a real run took (the
 * model calling `fill` rather than `draft`) nothing invoked it. A live
 * application reached the Submit gate showing 900 words of generated prose with
 * no warnings, because the only two call sites were the `draft` tool and the
 * edit handler. These tests fail if that wiring is ever removed again.
 */
describe("buildGateView — §7.4 runs when the gate is built", () => {
  const facts = factsOf({
    name: "Andes Lee", email: "a@b.c", phone: "", location: "",
    workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
    employers: [{ company: "Acme Corp", title: "Engineer", start: "2021", end: "2024", bullets: [] }],
    education: [], answers: {}, verifiedFields: [],
  });

  const long = (claim: string) =>
    `${claim} I care about this work and would bring the same focus to your team here.`;

  it("warns on a generated value naming an organisation that is not in the profile", () => {
    const v = buildGateView([filled("Why this role?", long("I led the platform team at Globex."), "generated")], facts);
    expect(v.groups[0]!.items[0]!.warning).toContain("Globex");
  });

  it("stays silent on a generated value that checks out", () => {
    const v = buildGateView([filled("Why this role?", long("I led the platform team at Acme Corp."), "generated")], facts);
    expect(v.groups[0]!.items[0]!.warning).toBeUndefined();
  });

  it("does not check profile values against the profile", () => {
    // A profile value failing §7.4 would mean the profile disagrees with
    // itself — a real problem, but not one to raise over a Submit button.
    const v = buildGateView([filled("Employer", long("Globex Industries"), "profile")], facts);
    expect(v.groups[0]!.items[0]!.warning).toBeUndefined();
  });

  it("skips values too short to carry a claim", () => {
    const v = buildGateView([filled("City", "Globex", "generated")], facts);
    expect(v.groups[0]!.items[0]!.warning).toBeUndefined();
  });
});
