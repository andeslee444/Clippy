import type OpenAI from "openai";

type Msg = OpenAI.Chat.ChatCompletionMessageParam;

/** Results longer than this are candidates for shrinking once superseded. */
const BULKY = 400;

/**
 * Descriptive, never imperative.
 *
 * This previously read "call read_page for the current page" — and the model
 * obeyed it. Each read made the prior snapshot stale, which produced another
 * copy of the instruction, which produced another read: 60 read_page calls in
 * one run. Text injected into a model's context is not inert data; a tool
 * result carries the same imperative weight as the system prompt.
 */
export const SUPERSEDED = "[older page snapshot omitted to save space — the current page appears below]";

/**
 * Shrink superseded page snapshots in place, Chat-Completions shape (spec §8.3).
 *
 * The same invariant as the Anthropic version applies here for the same reason:
 * every `tool_calls` entry on an assistant message must be answered by a
 * `{role:"tool", tool_call_id}` message. Dropping or reordering messages breaks
 * that pairing and the API rejects it. So messages are never removed and ids are
 * never touched — only the CONTENT of bulky, superseded tool results changes.
 *
 * Only `read_page` results are shrunk. Size alone is the wrong test: a large
 * result from some other tool is not recoverable by re-reading the page, so
 * replacing it with that instruction would be actively misleading.
 */
export function compactOpenAIMessages(messages: Msg[]): Msg[] {
  // tool_call_id → function name, gathered from the assistant turns that made them.
  const toolOf = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const call of msg.tool_calls ?? []) {
      if (call.type === "function") toolOf.set(call.id, call.function.name);
    }
  }

  const bulky: number[] = [];
  messages.forEach((msg, i) => {
    if (msg.role !== "tool") return;
    if (toolOf.get(msg.tool_call_id) !== "read_page") return;
    if (typeof msg.content === "string" && msg.content.length > BULKY) bulky.push(i);
  });

  if (bulky.length <= 1) return messages;
  const stale = new Set(bulky.slice(0, -1));

  return messages.map((msg, i) =>
    stale.has(i) && msg.role === "tool" ? { ...msg, content: SUPERSEDED } : msg,
  );
}
