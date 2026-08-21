import { describe, it, expect, vi } from "vitest";
import { OpenAICompatBrain, PROVIDERS, costOf } from "./openai-brain.js";
import type { BrainTools } from "./types.js";
import { DEFAULT_OBJECTIVE, type StepRecord } from "../orchestrator/types.js";
import type OpenAI from "openai";

const obj = { ...DEFAULT_OBJECTIVE, goal: "fill in my first name" };

const tools = (): BrainTools & { calls: string[] } => {
  const calls: string[] = [];
  const self: BrainTools & { calls: string[] } = {
    calls,
    steps: [],
    readPage: async () => { calls.push("read"); return 'g1-r0 textbox "First Name*"'; },
    capturePage: async () => ({ base64: "" }),
    perform: async (e) => {
      calls.push(`${e.kind}`);
      // Mirror makeTools: every perform appends a StepRecord. Without this the
      // budget assertions below would pass vacuously against an empty array.
      (self.steps as StepRecord[]).push({ action: e, outcome: { kind: "ok" }, effect: "ok" });
      return `ok — ${e.kind} ok`;
    },
  };
  return self;
};

/** Fake client returning a scripted sequence of completions. */
const fakeClient = (turns: Array<Partial<OpenAI.Chat.ChatCompletion.Choice["message"]>>) => {
  let i = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { role: "assistant", content: null, ...turns[i++] } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })),
      },
    },
  } as unknown as OpenAI;
};

const toolCall = (id: string, name: string, args: object) => ({
  id, type: "function" as const, function: { name, arguments: JSON.stringify(args) },
});

describe("costOf", () => {
  it("prices prompt and completion tokens per provider", () => {
    const p = { ...PROVIDERS.deepseek!, inputPrice: 1e-6, outputPrice: 10e-6 };
    expect(costOf({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }, p))
      .toBeCloseTo(1000 * 1e-6 + 100 * 10e-6, 9);
  });

  it("is zero when usage is absent", () => {
    expect(costOf(undefined, PROVIDERS.deepseek!)).toBe(0);
  });
});

describe("OpenAICompatBrain.fromEnv", () => {
  it("builds a deepseek brain from DEEPSEEK_API_KEY", () => {
    const b = OpenAICompatBrain.fromEnv({ CLIPPY_BRAIN: "deepseek", DEEPSEEK_API_KEY: "sk-x" } as never);
    expect(b).toBeInstanceOf(OpenAICompatBrain);
  });

  it("names the missing variable when the key is empty", () => {
    expect(() => OpenAICompatBrain.fromEnv({ CLIPPY_BRAIN: "deepseek" } as never))
      .toThrow(/DEEPSEEK_API_KEY/);
  });

  it("rejects an unknown provider by name", () => {
    expect(() => OpenAICompatBrain.fromEnv({ CLIPPY_BRAIN: "llama", OPENAI_API_KEY: "x" } as never))
      .toThrow(/Unknown CLIPPY_BRAIN "llama"/);
  });

  it("lets the model and prices be overridden per run", () => {
    const b = OpenAICompatBrain.fromEnv({
      CLIPPY_BRAIN: "openai", OPENAI_API_KEY: "sk-x", CLIPPY_MODEL: "gpt-test",
      CLIPPY_INPUT_PRICE: "0.000002",
    } as never);
    expect((b as unknown as { provider: { model: string; inputPrice: number } }).provider.model).toBe("gpt-test");
  });
});

describe("OpenAICompatBrain.pursue", () => {
  const brain = (client: OpenAI) => new OpenAICompatBrain(PROVIDERS.deepseek!, "sk-x", client);

  it("returns done when the model stops calling tools", async () => {
    const r = await brain(fakeClient([{ content: "all set" }])).pursue(obj, tools());
    expect(r.kind).toBe("done");
  });

  it("executes a tool call and feeds the result back", async () => {
    const t = tools();
    await brain(fakeClient([
      { tool_calls: [toolCall("c1", "fill", { ref: "g1-r0", value: "Andes" })] },
      { content: "done" },
    ])).pursue(obj, t);
    expect(t.calls).toContain("fill");
  });

  it("sends one tool message per call — omitting any is a 400", async () => {
    const client = fakeClient([
      { tool_calls: [toolCall("a", "read_page", {}), toolCall("b", "read_page", {})] },
      { content: "done" },
    ]);
    await brain(client).pursue(obj, tools());
    const second = vi.mocked(client.chat.completions.create).mock.calls[1]![0] as {
      messages: OpenAI.Chat.ChatCompletionMessageParam[];
    };
    const toolMsgs = second.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m as { tool_call_id: string }).tool_call_id).sort()).toEqual(["a", "b"]);
  });

  it("reports a malformed argument back to the model rather than throwing", async () => {
    const client = fakeClient([
      { tool_calls: [{ id: "c1", type: "function", function: { name: "fill", arguments: "{not json" } }] },
      { content: "sorry" },
    ]);
    const r = await brain(client).pursue(obj, tools());
    expect(r.kind).toBe("done");
    const second = vi.mocked(client.chat.completions.create).mock.calls[1]![0] as {
      messages: OpenAI.Chat.ChatCompletionMessageParam[];
    };
    expect(JSON.stringify(second.messages)).toMatch(/ERROR/);
  });

  it("stops as STUCK when a step was declined at the gate", async () => {
    const t = tools();
    t.perform = async () => {
      t.steps.push({ action: { kind: "submit", ref: "g1-r0" }, outcome: { kind: "stuck", reason: "approval denied for submit" }, effect: "" });
      return "DECLINED: approval denied for submit";
    };
    const r = await brain(fakeClient([
      { tool_calls: [toolCall("c1", "submit", { ref: "g1-r0" })] },
      { content: "ok" },
    ])).pursue(obj, t);
    expect(r.kind).toBe("stuck");
    if (r.kind !== "stuck") throw new Error("unreachable");
    expect(r.reason).toContain("approval denied");
  });

  it("stops when the budget is exhausted", async () => {
    const client = fakeClient(Array.from({ length: 10 }, () => ({
      tool_calls: [toolCall("c", "read_page", {})],
    })));
    const r = await new OpenAICompatBrain(PROVIDERS.deepseek!, "sk-x", client)
      .pursue({ ...obj, maxCost: 0.0000001 }, tools());
    expect(r.kind).toBe("stuck");
  });

  it("charges the step budget for effects that were performed", async () => {
    // Regression: neither brain called budget.record(), so `steps` stayed 0
    // forever, maxSteps was never enforced, and a run that filled two fields
    // reported "DONE — 0 steps". Only the cost ceiling could stop a runaway.
    const r = await brain(fakeClient([
      { tool_calls: [toolCall("c1", "fill", { ref: "g1-r0", value: "a" }),
                     toolCall("c2", "fill", { ref: "g1-r1", value: "b" })] },
      { content: "done" },
    ])).pursue(obj, tools());
    expect(r.steps).toBe(2);
  });

  it("stops when the STEP budget is exhausted, not just the cost budget", async () => {
    const client = fakeClient(Array.from({ length: 20 }, () => ({
      tool_calls: [toolCall("c", "fill", { ref: "g1-r0", value: "x" })],
    })));
    const r = await brain(client).pursue({ ...obj, maxSteps: 3, maxCost: 1000 }, tools());
    expect(r.kind).toBe("stuck");
    if (r.kind !== "stuck") throw new Error("unreachable");
    expect(r.reason).toMatch(/step budget/i);
    expect(r.steps).toBe(3);
  });
});
