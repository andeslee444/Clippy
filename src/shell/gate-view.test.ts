import { describe, it, expect } from "vitest";
import { buildGateView } from "./gate-view.js";
import type { StepRecord } from "../orchestrator/types.js";

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
    expect(buildGateView(steps).groups[0]!.provenance).toBe("generated");
  });

  it("expands the generated group and collapses the rest", () => {
    const v = buildGateView(steps);
    expect(v.groups.find((g) => g.provenance === "generated")!.expanded).toBe(true);
    expect(v.groups.find((g) => g.provenance === "profile")!.expanded).toBe(false);
  });

  it("counts each group", () => {
    const v = buildGateView(steps);
    expect(v.groups.find((g) => g.provenance === "profile")!.items).toHaveLength(3);
    expect(v.groups.find((g) => g.provenance === "generated")!.items).toHaveLength(1);
  });

  it("omits a group with no members rather than showing an empty one", () => {
    expect(buildGateView([filled("Name", "x", "profile")]).groups.map((g) => g.provenance))
      .toEqual(["profile"]);
  });

  it("treats an unmarked value as unknown, never as trusted", () => {
    // A value with no provenance has NOT been shown to come from the profile.
    // Defaulting it to `profile` would hide exactly the case worth seeing.
    const v = buildGateView([filled("Mystery", "x")]);
    expect(v.groups[0]!.provenance).toBe("unknown");
  });

  it("sorts unknown alongside generated, ahead of profile", () => {
    const v = buildGateView([filled("A", "x", "profile"), filled("B", "y")]);
    expect(v.groups[0]!.provenance).toBe("unknown");
  });

  it("ignores steps that are not fills", () => {
    const withClick: StepRecord[] = [
      ...steps,
      { action: { kind: "click", ref: "g1-r9" }, outcome: { kind: "ok" }, effect: "clicked" },
    ];
    expect(buildGateView(withClick).total).toBe(4);
  });

  it("reports the total so the dialog can say 'reviewing 3 of 18'", () => {
    const v = buildGateView(steps);
    expect(v.total).toBe(4);
    expect(v.needsReview).toBe(1);
  });
});

describe("buildGateView — edit support", () => {
  it("carries the ref so an edit can re-fill that exact element", () => {
    const v = buildGateView([filled("Why this role?", "text", "generated")]);
    expect(v.groups[0]!.items[0]!.ref).toBe("g1-r1");
  });

  it("marks human-edited values as their own group, ahead of profile", () => {
    const v = buildGateView([
      filled("Name", "Andes", "profile"),
      filled("Why this role?", "I rewrote this myself", "human"),
    ]);
    expect(v.groups.map((g) => g.provenance)).toEqual(["human", "profile"]);
  });

  it("does not ask for review of a value the human wrote", () => {
    // They just wrote it. Asking them to vet their own sentence is noise.
    const v = buildGateView([filled("Why this role?", "mine", "human")]);
    expect(v.needsReview).toBe(0);
  });
});

