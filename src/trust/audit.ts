import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Action } from "../hands/types.js";

export interface Outcome {
  ok: boolean;
  error?: string;
}

/**
 * Append-only JSONL audit log (spec §7.3).
 *
 * Two lines per action: `attempt` written BEFORE execution, `outcome` after.
 * The pair shares a `seq`. A lone `attempt` with no matching `outcome` means
 * the process died mid-action — which is exactly the evidence we want.
 */
export class AuditLog {
  #seq = 0;
  #failure: Error | null = null;
  #ready: Promise<void>;

  constructor(private readonly path: string) {
    this.#ready = mkdir(dirname(path), { recursive: true })
      .then(() => undefined)
      .catch((err: Error) => { this.#failure = err; });
  }

  async #check(): Promise<void> {
    await this.#ready;
    if (this.#failure) {
      throw new Error(`Audit log unavailable at ${this.path}: ${this.#failure.message}`);
    }
  }

  async attempt(action: Action, meta: { gated: boolean }): Promise<number> {
    await this.#check();
    const seq = ++this.#seq;
    await this.#write({ phase: "attempt", seq, ts: Date.now(), action, gated: meta.gated });
    return seq;
  }

  async outcome(seq: number, outcome: Outcome): Promise<void> {
    await this.#check();
    await this.#write({ phase: "outcome", seq, ts: Date.now(), ...outcome });
  }

  async #write(entry: Record<string, unknown>): Promise<void> {
    await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
  }
}
