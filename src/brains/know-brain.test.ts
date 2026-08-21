import { describe, it, expect, vi } from "vitest";
import { JenovaKnowBrain, parseSSE, AGENTS } from "./know-brain.js";

const sse = (lines: string[]) => lines.join("\n") + "\n";

describe("parseSSE", () => {
  it("assembles chunk_content across deltas", () => {
    const out = parseSSE(sse([
      'event: stream_started', 'data: {"session_id":"s1","run_id":"r1"}', '',
      'event: stream_delta', 'data: {"chunk_content":"Hello "}', '',
      'event: stream_delta', 'data: {"chunk_content":"world"}', '',
      'event: stream_ended', 'data: {"success":true,"usage":{"cost":"0.0032"}}', '',
    ]));
    expect(out.text).toBe("Hello world");
    expect(out.cost).toBeCloseTo(0.0032, 6);
  });

  it("reports failure when the run did not succeed", () => {
    const out = parseSSE(sse([
      'event: stream_ended', 'data: {"success":false,"stop_reason":"user_action_timeout"}', '',
    ]));
    expect(out.ok).toBe(false);
    expect(out.stopReason).toBe("user_action_timeout");
  });

  it("surfaces an mcp_connection event as needing the user", () => {
    const out = parseSSE(sse([
      'event: mcp_connection', 'data: {"auth_url":"https://x/auth"}', '',
    ]));
    expect(out.needsUser).toBe(true);
  });

  it("ignores malformed data lines rather than throwing", () => {
    const out = parseSSE(sse([
      'event: stream_delta', 'data: {not json}', '',
      'event: stream_delta', 'data: {"chunk_content":"ok"}', '',
    ]));
    expect(out.text).toBe("ok");
  });

  it("defaults cost to zero when absent", () => {
    expect(parseSSE(sse(['event: stream_ended', 'data: {"success":true}', ''])).cost).toBe(0);
  });
});

describe("AGENTS", () => {
  it("routes each task to its §13 agent", () => {
    expect(AGENTS.findPostings).toBe("career-advisor");
    expect(AGENTS.assessFit).toBe("resume-screener");
    expect(AGENTS.draft).toBe("resume-and-cover-letter-writer");
    expect(AGENTS.general).toBe("jenova");
  });
});

describe("JenovaKnowBrain", () => {
  const okResponse = () => ({
    ok: true,
    body: null,
    text: async () => sse([
      'event: stream_delta', 'data: {"chunk_content":"a fine answer"}', '',
      'event: stream_ended', 'data: {"success":true,"usage":{"cost":"0.01"}}', '',
    ]),
  }) as unknown as Response;

  it("posts to /v1/messages with the bearer key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse());
    const b = new JenovaKnowBrain("jnv_sk_x", fetchFn);
    await b.ask("assessFit", "does this fit?");
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.jenova.ai/v1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jnv_sk_x");
  });

  it("sends ephemeral:true so one-shots cost no session fee", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse());
    await new JenovaKnowBrain("k", fetchFn).ask("assessFit", "q");
    const body = JSON.parse(((fetchFn.mock.calls[0]! as [string, RequestInit])[1].body) as string);
    expect(body.ephemeral).toBe(true);
  });

  it("routes to the agent for the task", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => okResponse());
    await new JenovaKnowBrain("k", fetchFn).ask("draft", "write a bullet");
    const body = JSON.parse(((fetchFn.mock.calls[0]! as [string, RequestInit])[1].body) as string);
    expect(body.agent).toBe("resume-and-cover-letter-writer");
  });

  it("returns the assembled text and cost", async () => {
    const r = await new JenovaKnowBrain("k", vi.fn(async () => okResponse())).ask("general", "hi");
    expect(r.text).toBe("a fine answer");
    expect(r.cost).toBeCloseTo(0.01, 6);
  });

  it("throws with the status when the request fails", async () => {
    const bad = { ok: false, status: 402, text: async () => '{"error":{"code":"insufficient_credit"}}' } as unknown as Response;
    await expect(new JenovaKnowBrain("k", vi.fn(async () => bad)).ask("general", "hi"))
      .rejects.toThrow(/402|insufficient_credit/);
  });
});
