import { isGated } from "../trust/policy.js";
import type { AuditLog } from "../trust/audit.js";
import type { Effect, ElementFacts, Observation } from "./types.js";

export class ApprovalDeniedError extends Error {
  constructor(public readonly effect: Effect) {
    super(`Approval denied for ${effect.kind}`);
    this.name = "ApprovalDeniedError";
  }
}

export interface GatedExecutorDeps {
  audit: AuditLog;
  /** Facts derived from the resolved DOM element. Undefined for ref-less effects. */
  resolveFacts: (effect: Effect) => Promise<ElementFacts | undefined>;
  perform: (effect: Effect) => Promise<void>;
  requestApproval: (effect: Effect, facts?: ElementFacts) => Promise<boolean>;
}

export class GatedExecutor {
  constructor(private readonly deps: GatedExecutorDeps) {}

  /** Gate, audit, then execute. Nothing side-effecting happens before the audit line. */
  async runEffect(effect: Effect): Promise<void> {
    const facts = await this.deps.resolveFacts(effect);
    const gated = isGated(effect, facts);

    // Written BEFORE the approval prompt, not after. requestApproval() blocks on
    // a human and can sit there indefinitely; a process killed at that prompt
    // must still leave evidence that this effect was proposed. Auditing after
    // approval would lose exactly the case §7.3 exists to record.
    const seq = await this.deps.audit.attempt(effect, { gated });

    if (gated && !(await this.deps.requestApproval(effect, facts))) {
      await this.deps.audit.outcome(seq, { ok: false, error: "approval denied" });
      throw new ApprovalDeniedError(effect);
    }

    try {
      await this.deps.perform(effect);
      await this.deps.audit.outcome(seq, { ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.deps.audit.outcome(seq, { ok: false, error });
      throw err;
    }
  }

  /** Observations never gate, but are still audited — §7.3 says every action is recorded. */
  async observe<T>(observation: Observation, run: () => Promise<T>): Promise<T> {
    const seq = await this.deps.audit.attempt(observation, { gated: false });
    try {
      const result = await run();
      await this.deps.audit.outcome(seq, { ok: true });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.deps.audit.outcome(seq, { ok: false, error });
      throw err;
    }
  }
}
