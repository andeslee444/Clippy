import { describe, it, expect, vi } from "vitest";
import { draftTailored } from "./draft.js";
import { factsOf, type Profile } from "../memory/profile.js";

const profile: Profile = {
  name: "A", email: "a@b.c", phone: "", location: "",
  workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
  employers: [{ company: "Acme Corp", title: "Senior Engineer", start: "2021", end: "2024",
    bullets: ["Led the platform migration, cutting p95 latency 40%"] }],
  education: [], answers: {}, verifiedFields: [],
};
const facts = factsOf(profile);
const brain = (texts: string[]) => {
  let i = 0;
  return {
    ask: vi.fn<(task: string, content: string) => Promise<{ text: string; cost: number }>>(
      async () => ({ text: texts[i++] ?? "", cost: 0.001 }),
    ),
  };
};

describe("draftTailored", () => {
  it("returns a draft that passes the validator", async () => {
    const r = await draftTailored(brain(["Led a platform migration at Acme Corp cutting p95 latency 40%"]) as never,
      facts, "posting text", 3);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Acme Corp");
  });

  it("REJECTS a fabricated draft and retries", async () => {
    const b = brain([
      "Senior Engineer at Globex Industries",                     // fabricated
      "Led a platform migration at Acme Corp cutting latency 40%", // clean
    ]);
    const r = await draftTailored(b as never, facts, "posting", 3);
    expect(r.ok).toBe(true);
    expect(b.ask).toHaveBeenCalledTimes(2);
  });

  it("tells the model WHAT was wrong on the retry", async () => {
    const b = brain(["At Globex Industries", "At Acme Corp in 2021"]);
    await draftTailored(b as never, facts, "posting", 3);
    const second = b.ask.mock.calls[1]![1] as string;
    expect(second).toContain("Globex Industries");
  });

  it("gives up after the attempt limit rather than lowering the bar", async () => {
    const b = brain(["At Globex", "At Initech", "At Umbrella"]);
    const r = await draftTailored(b as never, facts, "posting", 3);
    expect(r.ok).toBe(false);
    expect(b.ask).toHaveBeenCalledTimes(3);
  });

  it("never returns text that failed validation", async () => {
    const r = await draftTailored(brain(["At Globex Industries"]) as never, facts, "posting", 1);
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
  });

  it("accumulates cost across attempts", async () => {
    const r = await draftTailored(brain(["At Globex", "At Acme Corp"]) as never, facts, "posting", 3);
    expect(r.cost).toBeCloseTo(0.002, 6);
  });
});
