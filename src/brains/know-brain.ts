const ENDPOINT = "https://api.jenova.ai/v1/messages";

/**
 * Per-task agent routing (spec §13).
 *
 * `agent` is a per-request field, so routing costs nothing beyond picking a slug.
 * `resume-screener` is built to judge a resume AGAINST a job description for
 * hiring managers — pointing it at your own application inverts it into exactly
 * the fit question.
 */
export const AGENTS = {
  findPostings: "career-advisor",
  assessFit: "resume-screener",
  draft: "resume-and-cover-letter-writer",
  general: "jenova",
} as const;

export type KnowTask = keyof typeof AGENTS;

export interface SSEResult {
  text: string;
  cost: number;
  ok: boolean;
  stopReason?: string;
  /** An MCP connection needs the end user to authorise something (§5). */
  needsUser: boolean;
}

/**
 * Parse a Jenova SSE stream into text plus cost.
 *
 * Malformed `data:` lines are skipped rather than thrown — a single bad frame
 * mid-stream should not discard an otherwise complete answer.
 */
export function parseSSE(raw: string): SSEResult {
  let text = "";
  let cost = 0;
  let ok = true;
  let stopReason: string | undefined;
  let needsUser = false;
  let event = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      if (event === "mcp_connection") needsUser = true;
      continue;
    }
    if (!line.startsWith("data:")) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === "stream_delta" && typeof payload.chunk_content === "string") {
      text += payload.chunk_content;
    }
    if (event === "stream_ended") {
      if (payload.success === false) ok = false;
      if (typeof payload.stop_reason === "string") stopReason = payload.stop_reason;
      const usage = payload.usage as { cost?: string | number } | undefined;
      if (usage?.cost !== undefined) cost = Number(usage.cost);
    }
  }

  return { text, cost, ok, stopReason, needsUser };
}

export interface KnowAnswer {
  text: string;
  cost: number;
}

/**
 * Knowledge-work turns over the Jenova Agent API (spec §6.3).
 *
 * Never receives an image: Jenova requires publicly accessible HTTPS URLs for
 * file input (§5), so sending a screenshot of an application form would mean
 * publishing it. Vision is ActBrain-only.
 */
export class JenovaKnowBrain {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): JenovaKnowBrain {
    const key = env.JENOVA_API_KEY;
    if (!key) throw new Error("JENOVA_API_KEY is empty. Add it to .env.");
    return new JenovaKnowBrain(key);
  }

  async ask(task: KnowTask, content: string): Promise<KnowAnswer> {
    const response = await this.fetchFn(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: AGENTS[task],
        content,
        // No session fee, no stored history, cannot be continued (§5).
        ephemeral: true,
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Jenova ${response.status}: ${raw.slice(0, 200)}`);
    }

    const parsed = parseSSE(raw);
    if (parsed.needsUser) {
      throw new Error("Jenova agent needs an MCP authorisation — not supported in this flow");
    }
    if (!parsed.ok) {
      throw new Error(`Jenova run failed: ${parsed.stopReason ?? "unknown"}`);
    }
    return { text: parsed.text, cost: parsed.cost };
  }
}
