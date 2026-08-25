import OpenAI from "openai";
import { z } from "zod/v4";
import { BudgetTracker } from "../orchestrator/budget.js";
import { compactOpenAIMessages } from "../orchestrator/compact-openai.js";
import type { Objective, ObjectiveResult } from "../orchestrator/types.js";
import type { ActBrain, BrainTools } from "./types.js";
import { SYSTEM } from "./system-prompt.js";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

/**
 * A provider reachable through the OpenAI Chat Completions shape.
 *
 * DeepSeek serves an OpenAI-compatible API, so the only differences that matter
 * are the base URL, the model id, and the price per token.
 */
export interface ProviderConfig {
  name: string;
  baseURL?: string;
  model: string;
  /** USD per input token. */
  inputPrice: number;
  /** USD per output token. */
  outputPrice: number;
}

/**
 * Published list prices as of 2026-08. **Verify before trusting a bill** — these
 * move, and a stale number here silently under-reports spend rather than
 * erroring, which is the failure mode that matters for a budget ceiling.
 * Override per run with CLIPPY_MODEL / CLIPPY_INPUT_PRICE / CLIPPY_OUTPUT_PRICE.
 */
export const PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    name: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    inputPrice: 0.27 / 1_000_000,
    outputPrice: 1.1 / 1_000_000,
  },
  openai: {
    name: "openai",
    model: "gpt-5",
    inputPrice: 1.25 / 1_000_000,
    outputPrice: 10 / 1_000_000,
  },
};

/** Chat Completions tool shape. Same five tools the Anthropic brain exposes. */
const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_page",
      description:
        "Read the current page as a list of elements with refs. Call this first, and again after anything changes the page.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "fill",
      description: "Type a value into a text field, by ref.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" }, value: { type: "string" } },
        required: ["ref", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select",
      description: "Choose an option in a dropdown, by ref.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" }, value: { type: "string" } },
        required: ["ref", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click a non-submitting element, by ref. Refused for anything that submits a form.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit",
      description:
        "Submit the form. Always asks the human for approval first, and may be declined.",
      parameters: {
        type: "object",
        properties: { ref: { type: "string" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  },
];

const RefArg = z.object({ ref: z.string() });
const ValueArg = z.object({ ref: z.string(), value: z.string() });

/** Chat Completions reports token counts, not cost. */
export function costOf(
  usage: OpenAI.CompletionUsage | undefined,
  provider: ProviderConfig,
): number {
  if (!usage) return 0;
  return usage.prompt_tokens * provider.inputPrice + usage.completion_tokens * provider.outputPrice;
}

/**
 * ActBrain over any OpenAI-compatible Chat Completions endpoint.
 *
 * Deliberately a sibling of ClaudeActBrain rather than a generalisation of it.
 * The two wire formats differ in ways an abstraction would have to paper over —
 * content blocks versus a `tool_calls` array, one user message carrying all
 * results versus one `role:"tool"` message per result — and the shared parts
 * (budget, classification, digest, the gate) already live outside both.
 */
export class OpenAICompatBrain implements ActBrain {
  private readonly client: OpenAI;
  private readonly provider: ProviderConfig;

  constructor(provider: ProviderConfig, apiKey: string, client?: OpenAI) {
    this.provider = provider;
    this.client = client ?? new OpenAI({ apiKey, baseURL: provider.baseURL });
  }

  /** Build from CLIPPY_BRAIN and the matching key, with optional overrides. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAICompatBrain {
    const which = env.CLIPPY_BRAIN ?? "deepseek";
    const base = PROVIDERS[which];
    if (!base) {
      throw new Error(`Unknown CLIPPY_BRAIN "${which}" — expected one of: ${Object.keys(PROVIDERS).join(", ")}`);
    }
    const key = which === "deepseek" ? env.DEEPSEEK_API_KEY : env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        `CLIPPY_BRAIN=${which} but ${which === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY"} is empty. Add it to .env.`,
      );
    }
    const provider: ProviderConfig = {
      ...base,
      model: env.CLIPPY_MODEL ?? base.model,
      inputPrice: env.CLIPPY_INPUT_PRICE ? Number(env.CLIPPY_INPUT_PRICE) : base.inputPrice,
      outputPrice: env.CLIPPY_OUTPUT_PRICE ? Number(env.CLIPPY_OUTPUT_PRICE) : base.outputPrice,
    };
    return new OpenAICompatBrain(provider, key);
  }

  async pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult> {
    const budget = new BudgetTracker(objective);
    let messages: Msg[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: objective.context
          ? `${objective.goal}\n\n## Facts you may use\n${objective.context}`
          : objective.goal,
      },
    ];

    for (;;) {
      const exhausted = budget.exhausted();
      if (exhausted) {
        return { kind: "stuck", reason: exhausted, steps: budget.steps, cost: budget.cost };
      }

      const response = await this.client.chat.completions.create({
        model: this.provider.model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      });

      budget.spend(costOf(response.usage, this.provider));

      const choice = response.choices[0];
      if (!choice) {
        return { kind: "failed", reason: "no choices returned", steps: budget.steps, cost: budget.cost };
      }

      messages.push(choice.message);

      const calls = choice.message.tool_calls ?? [];
      if (calls.length === 0) {
        const message = (choice.message.content ?? "").trim();
        return { kind: "done", steps: budget.steps, cost: budget.cost, ...(message ? { message } : {}) };
      }

      // One `role:"tool"` message PER call — unlike Anthropic, where every result
      // for a turn rides in a single user message. Omitting any one of them is a
      // 400, not a degraded response.
      const before = tools.steps.length;
      for (const call of calls) {
        if (call.type !== "function") {
          messages.push({ role: "tool", tool_call_id: call.id, content: "ERROR: unsupported tool type" });
          continue;
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await this.#dispatch(call.function.name, call.function.arguments, tools),
        });
      }

      // Charge the step budget for what actually happened — see act-brain.ts.
      for (const step of tools.steps.slice(before)) budget.record(step.outcome);

      const declined = tools.steps.find((s) => s.outcome.kind === "stuck");
      if (declined && declined.outcome.kind === "stuck") {
        return { kind: "stuck", reason: declined.outcome.reason, steps: budget.steps, cost: budget.cost };
      }

      messages = compactOpenAIMessages(messages);
    }
  }

  async #dispatch(name: string, rawArgs: string, tools: BrainTools): Promise<string> {
    try {
      // Arguments arrive as a JSON *string* here, unlike Anthropic's parsed object.
      const args: unknown = rawArgs ? JSON.parse(rawArgs) : {};
      switch (name) {
        case "read_page":
          return await tools.readPage();
        case "fill": {
          const { ref, value } = ValueArg.parse(args);
          return await tools.perform({ kind: "fill", ref, value });
        }
        case "select": {
          const { ref, value } = ValueArg.parse(args);
          return await tools.perform({ kind: "select", ref, value });
        }
        case "click":
          return await tools.perform({ kind: "click", ref: RefArg.parse(args).ref });
        case "submit":
          return await tools.perform({ kind: "submit", ref: RefArg.parse(args).ref });
        default:
          return `ERROR: unknown tool ${name}`;
      }
    } catch (err) {
      // Malformed JSON or bad arguments from the model. Tell it; do not abort.
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
