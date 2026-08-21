import { describe, it, expect } from "vitest";
import { compactMessages } from "./compact-messages.js";
import { costOf } from "../brains/act-brain.js";
import type Anthropic from "@anthropic-ai/sdk";

type Msg = Anthropic.Beta.BetaMessageParam;

const tree = (n: number) => `g${n}-r0 textbox "First Name*"\n`.padEnd(2000, ".");

const turn = (id: string, n: number): Msg[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "read_page", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: tree(n) }] },
];

describe("compactMessages", () => {
  it("leaves a short conversation alone", () => {
    const msgs: Msg[] = [{ role: "user", content: "apply to this job" }, ...turn("a", 1)];
    expect(compactMessages(msgs)).toEqual(msgs);
  });

  it("keeps the most recent page result at full size", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2)];
    const out = compactMessages(msgs);
    expect(JSON.stringify(out)).toContain("g2-r0");
  });

  it("shrinks older page results", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2)];
    const out = compactMessages(msgs);
    expect(JSON.stringify(out)).not.toContain(tree(1));
  });

  it("preserves every tool_use_id — the API rejects an unmatched pair", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2), ...turn("c", 3)];
    const ids = (m: Msg[]) =>
      JSON.stringify(m).match(/"tool_use_id":"[a-z]"/g)?.sort() ?? [];
    expect(ids(compactMessages(msgs))).toEqual(ids(msgs));
  });

  it("preserves message count and roles exactly", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2)];
    const out = compactMessages(msgs);
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
  });

  it("shrinks a long conversation dramatically", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 20; i++) msgs.push(...turn(`t${i}`, i));
    const before = JSON.stringify(msgs).length;
    const after = JSON.stringify(compactMessages(msgs)).length;
    expect(after).toBeLessThan(before / 4);
  });

  it("does not touch non-page tool results", () => {
    const msgs: Msg[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "x", name: "fill", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok — fill ok" }] },
      ...turn("y", 9),
    ];
    expect(JSON.stringify(compactMessages(msgs))).toContain("ok — fill ok");
  });
});

describe("costOf", () => {
  it("prices input and output tokens", () => {
    const c = costOf({ input_tokens: 1_000_000, output_tokens: 0 } as never);
    expect(c).toBeCloseTo(5, 5);
  });

  it("prices cache reads at a tenth of fresh input", () => {
    const c = costOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 } as never);
    expect(c).toBeCloseTo(0.5, 5);
  });

  it("prices output at five times input", () => {
    const c = costOf({ input_tokens: 0, output_tokens: 1_000_000 } as never);
    expect(c).toBeCloseTo(25, 5);
  });
});
