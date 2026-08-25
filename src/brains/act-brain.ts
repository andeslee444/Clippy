import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { BudgetTracker } from "../orchestrator/budget.js";
import { compactMessages } from "../orchestrator/compact-messages.js";
import type { Objective, ObjectiveResult } from "../orchestrator/types.js";
import type { ActBrain, BrainTools } from "./types.js";
import { SYSTEM } from "./system-prompt.js";

/** claude-opus-5, USD per token. Cache reads bill at a tenth of fresh input. */
const IN = 5 / 1_000_000;
const OUT = 25 / 1_000_000;

/** BetaUsage carries token counts, not a cost — there is no `usage.cost` field. */
export function costOf(usage: Anthropic.Beta.BetaUsage): number {
  const cached = usage.cache_read_input_tokens ?? 0;
  return usage.input_tokens * IN + cached * IN * 0.1 + usage.output_tokens * OUT;
}


const TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "read_page", description: "Read the current page as a list of elements with refs. Call this first, and again after anything changes the page.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "fill", description: "Type a value into a text field, by ref.", input_schema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"], additionalProperties: false } },
  { name: "select", description: "Choose an option in a dropdown, by ref.", input_schema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"], additionalProperties: false } },
  { name: "click", description: "Click a non-submitting element, by ref. Refused for anything that submits a form.", input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false } },
  {
    name: "need_human",
    description:
      "Stop and hand back to the person. Use for a login wall, a CAPTCHA, or anything you cannot do without them. Say what is blocking you.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  { name: "submit", description: "Submit the form. Always asks the human for approval first, and may be declined.", input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false } },
];

/** Sentinel the dispatcher returns so the loop can end the run as stuck. */
export const NEED_HUMAN = "__CLIPPY_NEED_HUMAN__";

const RefArg = z.object({ ref: z.string() });
const ValueArg = z.object({ ref: z.string(), value: z.string() });

/**
 * Drives one objective with a hand-written agentic loop.
 *
 * The SDK's Tool Runner was ruled out: calling `setMessagesParams()` mid-loop —
 * the only compaction hook it offers — sets an internal `#mutated` flag that
 * skips pushing the assistant turn, so the turn's tool calls are silently
 * dropped and never execute. Owning the message array avoids that entirely and
 * makes §8.3 a straightforward transformation of an array we control.
 */
export class ClaudeActBrain implements ActBrain {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    // Zero-arg resolves ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an
    // `ant auth login` profile — no env var is not the same as no credentials.
    this.client = client ?? new Anthropic();
  }

  /** Set per run so #dispatch can charge observations against the budget. */
  private onObserve?: () => void;

  async pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult> {
    const budget = new BudgetTracker(objective);
    this.onObserve = () => budget.observe();
    let messages: Anthropic.Beta.BetaMessageParam[] = [
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

      const response = await this.client.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 8000,
        // Simple, high-volume decisions: fewer consolidated calls, less preamble.
        output_config: { effort: "low" },
        thinking: { type: "adaptive" },
        // Stable prefix — system + tools are resent every turn.
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        // readOnly offers observation only — the acting tools are not in the
        // schema at all, so they cannot be called.
        tools: objective.readOnly
          ? TOOLS.filter((t) => t.name === "read_page" || t.name === "need_human")
          : TOOLS,
        messages,
      });

      budget.spend(costOf(response.usage));

      if (response.stop_reason === "refusal") {
        return { kind: "stuck", reason: "model refused", steps: budget.steps, cost: budget.cost };
      }

      messages.push({ role: "assistant", content: response.content });

      // Server-side tool paused the turn; resend to continue.
      if (response.stop_reason === "pause_turn") continue;

      const calls = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (calls.length === 0) {
        const message = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { kind: "done", steps: budget.steps, cost: budget.cost, ...(message ? { message } : {}) };
      }

      // All results for one assistant turn go back in ONE user message.
      // Splitting them trains the model out of parallel tool use.
      const before = tools.steps.length;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: await this.#dispatch(call, tools),
        });
      }
      messages.push({ role: "user", content: results });

      // Charge the step budget for what actually happened. Without this,
      // `steps` stays 0 forever and maxSteps is never enforced — only the cost
      // ceiling would ever stop a runaway loop, and the run reports "0 steps"
      // however much work it did. `record` skips stale-ref retries (§8.4).
      for (const step of tools.steps.slice(before)) budget.record(step.outcome);

      // A model that recognises it is blocked can now SAY so structurally.
      // Previously it could only explain in prose, which always produced
      // `done` — so "there is a login wall, I need you" was indistinguishable
      // from "finished successfully".
      const blocked = calls.find((c) => c.name === "need_human");
      if (blocked) {
        const reason = String((blocked.input as { reason?: string }).reason ?? "needs a human");
        return { kind: "stuck", reason, steps: budget.steps, cost: budget.cost };
      }

      const declined = tools.steps.find((s) => s.outcome.kind === "stuck");
      if (declined && declined.outcome.kind === "stuck") {
        return { kind: "stuck", reason: declined.outcome.reason, steps: budget.steps, cost: budget.cost };
      }

      // §8.3 — shrink superseded page snapshots. Ids and pairing are preserved.
      messages = compactMessages(messages);
    }
  }

  async #dispatch(call: Anthropic.Beta.BetaToolUseBlock, tools: BrainTools): Promise<string> {
    try {
      switch (call.name) {
        case "read_page":
          this.onObserve?.();
          return await tools.readPage();
        case "need_human":
          // Handled by the loop, which turns it into a stuck result.
          return NEED_HUMAN;
        case "fill": {
          const { ref, value } = ValueArg.parse(call.input);
          return await tools.perform({ kind: "fill", ref, value });
        }
        case "select": {
          const { ref, value } = ValueArg.parse(call.input);
          return await tools.perform({ kind: "select", ref, value });
        }
        case "click":
          return await tools.perform({ kind: "click", ref: RefArg.parse(call.input).ref });
        case "submit":
          return await tools.perform({ kind: "submit", ref: RefArg.parse(call.input).ref });
        default:
          return `ERROR: unknown tool ${call.name}`;
      }
    } catch (err) {
      // Malformed arguments from the model. Tell it; do not abort the run.
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
