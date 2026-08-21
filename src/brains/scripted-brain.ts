import type { Objective, ObjectiveResult, StepRecord } from "../orchestrator/types.js";
import { BudgetTracker } from "../orchestrator/budget.js";
import type { ActBrain, BrainTools } from "./types.js";
import type { Effect } from "../hands/types.js";

/**
 * Replays a fixed list of effects. Not a model.
 *
 * Exists so the orchestrator, the tools, the gate, and the browser can all be
 * exercised end-to-end with no API key and no network — and so a CLI demo works
 * before the author supplies a key.
 */
export interface ScriptedStep {
  kind: Effect["kind"];
  /** Substring of the target element's accessible name, matched case-insensitively. */
  match: string;
  value?: string;
}

/** Parse one line of a rendered snapshot: `ref role "name"[ = "value"]`. */
export function parseRefLine(line: string): { ref: string; name: string } | null {
  const m = /^(\S+)\s+\S+\s+"([^"]*)"/.exec(line.trim());
  return m ? { ref: m[1]!, name: m[2]! } : null;
}

/** First ref whose accessible name contains `match`. */
export function findRef(tree: string, match: string): string | null {
  const needle = match.toLowerCase();
  for (const line of tree.split("\n")) {
    const parsed = parseRefLine(line);
    if (parsed && parsed.name.toLowerCase().includes(needle)) return parsed.ref;
  }
  return null;
}

export class ScriptedBrain implements ActBrain {
  constructor(
    private readonly script: ScriptedStep[],
    private readonly onStep?: (r: StepRecord) => void,
  ) {}

  async pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult> {
    const budget = new BudgetTracker(objective);
    // Read first, then resolve names to refs from THIS snapshot. A caller cannot
    // usefully supply a ref: this readPage bumps the generation and invalidates
    // anything captured earlier — which is the staleness mechanism working, not
    // a bug to route around.
    let tree = await tools.readPage();
    let lastError: string | null = null;

    for (const step of this.script) {
      const reason = budget.exhausted();
      if (reason) return { kind: "stuck", reason, steps: budget.steps, cost: budget.cost };

      const ref = findRef(tree, step.match);
      if (!ref) {
        return {
          kind: "failed",
          reason: `no element matching "${step.match}" on the page`,
          steps: budget.steps,
          cost: budget.cost,
        };
      }
      const effect = {
        kind: step.kind,
        ref,
        ...(step.value !== undefined ? { value: step.value } : {}),
      } as Effect;

      const result = await tools.perform(effect);
      const ok = result.startsWith("ok");
      budget.record(ok ? { kind: "ok" } : { kind: "retry", reason: result });
      this.onStep?.({
        action: effect,
        outcome: ok ? { kind: "ok" } : { kind: "retry", reason: result },
        effect: result,
      });

      if (result.startsWith("DECLINED")) {
        return { kind: "stuck", reason: result, steps: budget.steps, cost: budget.cost };
      }
      if (!ok) lastError = result;
      // The page may have changed; re-read so later steps resolve against it.
      if (ok) tree = await tools.readPage();
    }

    // A script that ran to the end but hit errors is FAILED, not done. Reporting
    // done here hid a real defect: `demo <submitRef>` built a fill against a
    // button, the fill failed, and the run still printed DONE.
    return lastError
      ? { kind: "failed", reason: lastError, steps: budget.steps, cost: budget.cost }
      : { kind: "done", steps: budget.steps, cost: budget.cost };
  }
}
