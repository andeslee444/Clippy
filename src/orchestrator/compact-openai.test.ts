import { describe, it, expect } from "vitest";
import { compactOpenAIMessages, SUPERSEDED } from "./compact-openai.js";
import type OpenAI from "openai";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

const tree = (n: number) => `g${n}-r0 textbox "First Name*"\n`.padEnd(2000, ".");

/** One read_page round trip: assistant asks, tool answers. */
const turn = (id: string, n: number, fn = "read_page"): Msg[] => [
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: fn, arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: id, content: tree(n) },
];

const ids = (m: Msg[]) =>
  m.flatMap((x) =>
    x.role === "assistant" ? (x.tool_calls ?? []).map((c) => c.id) : x.role === "tool" ? [x.tool_call_id] : [],
  ).sort();

describe("compactOpenAIMessages", () => {
  it("leaves a short conversation alone", () => {
    const msgs: Msg[] = [{ role: "user", content: "apply" }, ...turn("a", 1)];
    expect(compactOpenAIMessages(msgs)).toEqual(msgs);
  });

  it("keeps the most recent page result at full size", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2)];
    expect(JSON.stringify(compactOpenAIMessages(msgs))).toContain("g2-r0");
  });

  it("shrinks older page results", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2)];
    const out = JSON.stringify(compactOpenAIMessages(msgs));
    // NOT tree(1): JSON.stringify escapes its quotes, so that literal never
    // matches and the assertion passes vacuously. The ref token has no quotes.
    expect(out).not.toContain("g1-r0");
    expect(out).toContain(SUPERSEDED);
  });

  it("preserves every tool_call_id — the API rejects an unmatched pair", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2), ...turn("c", 3)];
    expect(ids(compactOpenAIMessages(msgs))).toEqual(ids(msgs));
  });

  it("preserves message count and roles exactly", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }, ...turn("a", 1), ...turn("b", 2)];
    const out = compactOpenAIMessages(msgs);
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
  });

  it("does not touch results from other tools, however large", () => {
    const big = "IMAGE_DATA".padEnd(5000, "x");
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "x", type: "function", function: { name: "capture_page", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "x", content: big },
      ...turn("y", 9),
      ...turn("z", 10),
    ];
    const out = JSON.stringify(compactOpenAIMessages(msgs));
    expect(out).toContain(big);
    expect(out).not.toContain("g9-r0");
  });

  it("shrinks a long conversation dramatically", () => {
    const msgs: Msg[] = [{ role: "user", content: "go" }];
    for (let i = 0; i < 20; i++) msgs.push(...turn(`t${i}`, i));
    const before = JSON.stringify(msgs).length;
    const after = JSON.stringify(compactOpenAIMessages(msgs)).length;
    expect(after).toBeLessThan(before / 4);
  });

  it("handles parallel tool calls in one assistant turn", () => {
    const msgs: Msg[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "p1", type: "function", function: { name: "read_page", arguments: "{}" } },
          { id: "p2", type: "function", function: { name: "read_page", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "p1", content: tree(1) },
      { role: "tool", tool_call_id: "p2", content: tree(2) },
      ...turn("later", 3),
    ];
    const out = compactOpenAIMessages(msgs);
    expect(ids(out)).toEqual(ids(msgs));
    expect(out).toHaveLength(msgs.length);
    expect(JSON.stringify(out)).toContain("g3-r0");
  });
});
