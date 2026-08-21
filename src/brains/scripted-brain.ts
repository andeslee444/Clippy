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
export class ScriptedBrain implements ActBrain {
  constructor(
    private readonly script: Effect[],
    private readonly onStep?: (r: StepRecord) => void,
  ) {}

  async pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult> {
    const budget = new BudgetTracker(objective);
    await tools.readPage();

    for (const effect of this.script) {
      const reason = budget.exhausted();
      if (reason) return { kind: "stuck", reason, steps: budget.steps, cost: budget.cost };

      const result = await tools.perform(effect);
      budget.record({ kind: result.startsWith("ok") ? "ok" : "retry", reason: result });
      this.onStep?.({ action: effect, outcome: { kind: "ok" }, effect: result });

      if (result.startsWith("DECLINED")) {
        return { kind: "stuck", reason: result, steps: budget.steps, cost: budget.cost };
      }
    }
    return { kind: "done", steps: budget.steps, cost: budget.cost };
  }
}
