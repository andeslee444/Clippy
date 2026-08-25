import type Anthropic from "@anthropic-ai/sdk";

type Msg = Anthropic.Beta.BetaMessageParam;

/** Results longer than this are candidates for shrinking once superseded. */
const BULKY = 400;

/**
 * Shrink superseded page snapshots in place (spec §8.3).
 *
 * Messages are never removed and ids are never touched: the Messages API requires
 * every `tool_use` block to be answered by a `tool_result` with a matching
 * `tool_use_id`, so dropping or reordering messages produces a 400. Only the
 * CONTENT of bulky, superseded tool results is replaced.
 *
 * The most recent bulky result is left intact — that one describes the page as it
 * is now. Everything before it describes a page that no longer exists, so it costs
 * input tokens on every subsequent turn and actively misleads.
 */
export function compactMessages(messages: Msg[]): Msg[] {
  // Which tool produced each result. Size alone is the wrong test: a large
  // result from some other tool would be replaced with a message telling the
  // model to call read_page, which is both wrong and confusing. Only a page
  // snapshot can be recovered by re-reading the page.
  const toolOf = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") toolOf.set(block.id, block.name);
    }
  }

  const bulky: Array<[number, number]> = [];

  messages.forEach((msg, mi) => {
    if (!Array.isArray(msg.content)) return;
    msg.content.forEach((block, bi) => {
      if (block.type !== "tool_result") return;
      if (toolOf.get(block.tool_use_id) !== "read_page") return;
      if (typeof block.content === "string" && block.content.length > BULKY) {
        bulky.push([mi, bi]);
      }
    });
  });

  if (bulky.length <= 1) return messages;
  const stale = bulky.slice(0, -1);

  return messages.map((msg, mi) => {
    const hits = stale.filter(([m]) => m === mi);
    if (hits.length === 0 || !Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map((block, bi) =>
        hits.some(([, b]) => b === bi) && block.type === "tool_result"
          ? { ...block, content: "[older page snapshot omitted to save space — the current page appears below]" }
          : block,
      ),
    };
  });
}
