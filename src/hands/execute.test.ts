import { describe, it, expect, vi } from "vitest";
import { GatedExecutor, ApprovalDeniedError } from "./execute.js";
import type { AuditLog } from "../trust/audit.js";
import type { Effect, ElementFacts } from "./types.js";

/** Minimal fake matching AuditLog's public shape. AuditLog has private fields,
 * so a structural object can't satisfy its type without a cast — that's fine
 * for a test double. Returns the vi.fn()s alongside the cast object so
 * assertions keep their mock typing. */
function fakeAudit(onCall?: (line: string) => void) {
  let seq = 0;
  const attempt = vi.fn(async (_action: unknown, _meta: unknown) => {
    seq += 1;
    onCall?.("attempt");
    return seq;
  });
  const outcome = vi.fn(async (_seq: number, _o: unknown) => {
    onCall?.("outcome");
  });
  return { audit: { attempt, outcome } as unknown as AuditLog, attempt, outcome };
}

const fillEffect: Effect = { kind: "fill", ref: "g1-r1", value: "Andes" };
const submitEffect: Effect = { kind: "submit", ref: "g1-r2" };
const clickEffect: Effect = { kind: "click", ref: "g1-r3" };

describe("GatedExecutor.runEffect", () => {
  it("executes an ungated effect without requesting approval", async () => {
    const { audit } = fakeAudit();
    const perform = vi.fn(async () => {});
    const requestApproval = vi.fn(async () => true);
    const resolveFacts = vi.fn(async () => undefined);
    const executor = new GatedExecutor({ audit, resolveFacts, perform, requestApproval });

    await executor.runEffect(fillEffect);

    expect(perform).toHaveBeenCalledWith(fillEffect);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("asks for approval on a gated effect, then executes when approved", async () => {
    const { audit } = fakeAudit();
    const perform = vi.fn(async () => {});
    const requestApproval = vi.fn(async () => true);
    const resolveFacts = vi.fn(async () => undefined);
    const executor = new GatedExecutor({ audit, resolveFacts, perform, requestApproval });

    await executor.runEffect(submitEffect);

    expect(requestApproval).toHaveBeenCalledWith(submitEffect, undefined);
    expect(perform).toHaveBeenCalledWith(submitEffect);
  });

  it("does not execute and rejects with ApprovalDeniedError when denied", async () => {
    const { audit } = fakeAudit();
    const perform = vi.fn(async () => {});
    const requestApproval = vi.fn(async () => false);
    const resolveFacts = vi.fn(async () => undefined);
    const executor = new GatedExecutor({ audit, resolveFacts, perform, requestApproval });

    await expect(executor.runEffect(submitEffect)).rejects.toThrow(ApprovalDeniedError);
    expect(perform).not.toHaveBeenCalled();
  });

  it("writes the audit attempt before perform runs", async () => {
    const calls: string[] = [];
    const { audit } = fakeAudit((line) => calls.push(line));
    const perform = vi.fn(async () => {
      calls.push("perform");
    });
    const executor = new GatedExecutor({
      audit,
      resolveFacts: async () => undefined,
      perform,
      requestApproval: async () => true,
    });

    await executor.runEffect(fillEffect);

    expect(calls).toEqual(["attempt", "perform", "outcome"]);
  });

  it("records a failed outcome and rethrows when perform throws", async () => {
    const { audit, outcome } = fakeAudit();
    const perform = vi.fn(async () => {
      throw new Error("boom");
    });
    const executor = new GatedExecutor({
      audit,
      resolveFacts: async () => undefined,
      perform,
      requestApproval: async () => true,
    });

    await expect(executor.runEffect(fillEffect)).rejects.toThrow("boom");
    expect(outcome).toHaveBeenCalledWith(1, { ok: false, error: "boom" });
  });

  it("gates a click on a submit-capable element — consults facts, not just kind", async () => {
    const { audit } = fakeAudit();
    const perform = vi.fn(async () => {});
    const requestApproval = vi.fn(async () => true);
    const facts: ElementFacts = { submitCapable: true, formless: false };
    const resolveFacts = vi.fn(async () => facts);
    const executor = new GatedExecutor({ audit, resolveFacts, perform, requestApproval });

    await executor.runEffect(clickEffect);

    expect(requestApproval).toHaveBeenCalledWith(clickEffect, facts);
  });

  it("gates a click on a form-less page", async () => {
    const { audit } = fakeAudit();
    const perform = vi.fn(async () => {});
    const requestApproval = vi.fn(async () => true);
    const facts: ElementFacts = { submitCapable: false, formless: true };
    const resolveFacts = vi.fn(async () => facts);
    const executor = new GatedExecutor({ audit, resolveFacts, perform, requestApproval });

    await executor.runEffect(clickEffect);

    expect(requestApproval).toHaveBeenCalledWith(clickEffect, facts);
  });
});

describe("GatedExecutor.observe", () => {
  it("returns the value its callback produced", async () => {
    const { audit } = fakeAudit();
    const executor = new GatedExecutor({
      audit,
      resolveFacts: async () => undefined,
      perform: vi.fn(async () => {}),
      requestApproval: vi.fn(async () => true),
    });

    const result = await executor.observe({ kind: "readPage" }, async () => 42);

    expect(result).toBe(42);
  });

  it("writes an audit pair and never calls requestApproval", async () => {
    const { audit, attempt, outcome } = fakeAudit();
    const requestApproval = vi.fn(async () => true);
    const executor = new GatedExecutor({
      audit,
      resolveFacts: async () => undefined,
      perform: vi.fn(async () => {}),
      requestApproval,
    });

    await executor.observe({ kind: "capturePage" }, async () => "ok");

    expect(attempt).toHaveBeenCalledWith({ kind: "capturePage" }, { gated: false });
    expect(outcome).toHaveBeenCalledWith(1, { ok: true });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("records a failed outcome and rethrows when the callback throws", async () => {
    const { audit, outcome } = fakeAudit();
    const executor = new GatedExecutor({
      audit,
      resolveFacts: async () => undefined,
      perform: vi.fn(async () => {}),
      requestApproval: vi.fn(async () => true),
    });

    await expect(
      executor.observe({ kind: "readPage" }, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(outcome).toHaveBeenCalledWith(1, { ok: false, error: "nope" });
  });
});
