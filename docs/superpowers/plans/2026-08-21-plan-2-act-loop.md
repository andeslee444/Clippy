# Clippy Plan 2 — Act Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given an open application form and a goal in words, fill the form and stop at Submit.

**Architecture:** The Claude SDK's beta Tool Runner owns the request→execute→loop cycle; our tools wrap `GatedExecutor`, so the trust gate sits inside each tool's `run()` — the pattern the SDK docs prescribe for human-in-the-loop. Everything with judgment in it — history compaction, failure classification, budget accounting — is a **pure function in `orchestrator/`**, tested without a network. `brains/act-brain.ts` is thin wiring over those.

**Tech Stack:** Adds `@anthropic-ai/sdk` (Tool Runner + `betaZodTool`). Everything else unchanged.

**Spec:** `docs/superpowers/specs/2026-08-20-clippy-v1-design.md` §6.3 (ActBrain), §8.1 (two-level loop), §8.3 (compaction), §8.4 (failure taxonomy).

**Predecessor:** Plans 1 and 1a, complete. 85 tests passing.

---

## ⚠️ Constraint that shapes this plan

**`ANTHROPIC_API_KEY` is not set and the `ant` CLI is not installed.** Nothing in this plan can be verified against the live model until the author supplies a key.

The response is not to skip testing — it is to put all the logic where it can be tested anyway:

| Module | Testable now? |
|---|---|
| `orchestrator/digest.ts` | ✅ pure |
| `orchestrator/classify.ts` | ✅ pure |
| `orchestrator/budget.ts` | ✅ pure |
| `brains/tools.ts` | ✅ against a fake executor |
| `brains/act-brain.ts` | ⚠️ wiring only — needs a key |
| CLI `do` | ⚠️ needs a key, but works offline via `ScriptedBrain` |

If a task tempts you to put a decision inside `act-brain.ts`, that decision belongs in a pure module instead. The untestable file should stay boring.

---

## Design decisions worth defending

**Tool Runner over a manual loop.** The SDK docs prefer it, and the one thing that argued for manual — human approval — is explicitly not a reason: gating happens inside `run()`, which returns a "declined" result the model can read. Compaction, the other concern, is reachable via `setMessagesParams()` between iterations.

**The gate stays where it is.** Tools call `executor.runEffect()`. `ApprovalDeniedError` becomes a tool *result*, not an exception — the model is told it was declined and instructed not to retry. A denial is information, not a crash.

**Stale refs are free.** §8.4 says a stale ref costs nothing because nothing executed. The budget tracks `chargeable` separately from `total`, so a re-render storm cannot silently consume an objective's step budget.

**One objective per run.** The outer planning loop (§8.1) needs `KnowBrain` to produce objectives, and that is Plan 3. Here the objective is the goal string the user typed.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/orchestrator/types.ts` | `Objective`, `Budget`, `StepOutcome`, `ObjectiveResult` |
| `src/orchestrator/digest.ts` | History compaction (§8.3) — pure |
| `src/orchestrator/classify.ts` | Error → `StepOutcome` (§8.4) — pure |
| `src/orchestrator/budget.ts` | Step/cost accounting with free retries — pure |
| `src/brains/types.ts` | `ActBrain` interface — the swappable seam |
| `src/brains/tools.ts` | Effect/observation tools wrapping `GatedExecutor` |
| `src/brains/act-brain.ts` | Claude Tool Runner wiring |
| `src/brains/scripted-brain.ts` | Replays a fixed action list — offline testing and CLI demo |
| `src/cli/spine.ts` | **Modify** — add `do <goal>` |

---

### Task P2-1: Orchestrator types

**Files:** Create `src/orchestrator/types.ts`, test `src/orchestrator/types.test.ts`

- [ ] **Step 1: Create `src/orchestrator/types.ts`**

```ts
import type { Action } from "../hands/types.js";

export interface Objective {
  /** What the user asked for, in words. */
  goal: string;
  /** Hard ceiling on chargeable steps (spec §8.1). */
  maxSteps: number;
  /** Hard ceiling on spend, USD. */
  maxCost: number;
}

export const DEFAULT_OBJECTIVE: Omit<Objective, "goal"> = { maxSteps: 40, maxCost: 1.5 };

/**
 * How one step ended (spec §8.4).
 *
 * `retry-free` is the load-bearing one: a stale ref means the page re-rendered
 * and NOTHING executed, so charging it against the budget would let a
 * re-render storm consume an objective without any work happening.
 */
export type StepOutcome =
  | { kind: "ok" }
  | { kind: "retry-free"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "stuck"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * How the objective ended.
 *
 * STUCK and FAILED are different (spec §8.4): STUCK means "I need you" and the
 * browser is frozen where it is; FAILED means "this is unachievable, move on".
 */
export type ObjectiveResult =
  | { kind: "done"; steps: number; cost: number }
  | { kind: "stuck"; reason: string; steps: number; cost: number }
  | { kind: "failed"; reason: string; steps: number; cost: number };

export interface StepRecord {
  action: Action;
  outcome: StepOutcome;
  /** One-line summary of what changed, for the compacted history (§8.3). */
  effect: string;
}
```

- [ ] **Step 2: Create `src/orchestrator/types.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_OBJECTIVE } from "./types.js";

describe("DEFAULT_OBJECTIVE", () => {
  it("matches the spec's opening budgets", () => {
    expect(DEFAULT_OBJECTIVE).toEqual({ maxSteps: 40, maxCost: 1.5 });
  });
});
```

- [ ] **Step 3: Run and commit**

Run: `npx vitest run src/orchestrator/types.test.ts` — expect PASS, 1 test.

```bash
git add src/orchestrator/types.ts src/orchestrator/types.test.ts
git commit -m "feat(orchestrator): objective, budget, and outcome types"
```

---

### Task P2-2: History compaction

**Files:** Create `src/orchestrator/digest.ts`, test `src/orchestrator/digest.test.ts`

Spec §8.3 calls this the highest-leverage code in the system. A full page tree is ~2 KB; forty of them accumulated is ~80 KB of input on every later decision, and the model reasons measurably worse over stale snapshots than over a clean action list.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/digest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { digestStep, compactHistory } from "./digest.js";
import type { StepRecord } from "./types.js";

const rec = (over: Partial<StepRecord> = {}): StepRecord => ({
  action: { kind: "fill", ref: "g1-r2", value: "Andes" },
  outcome: { kind: "ok" },
  effect: "field now reads 'Andes'",
  ...over,
});

describe("digestStep", () => {
  it("renders one line naming the action and what changed", () => {
    expect(digestStep(rec())).toBe(`fill g1-r2 "Andes" → field now reads 'Andes'`);
  });

  it("marks a failed step with its reason", () => {
    const line = digestStep(rec({ outcome: { kind: "retry", reason: "element not found" } }));
    expect(line).toContain("element not found");
  });

  it("truncates a very long fill value", () => {
    const line = digestStep(rec({ action: { kind: "fill", ref: "g1-r2", value: "x".repeat(500) } }));
    expect(line.length).toBeLessThan(160);
  });

  it("renders navigation by url", () => {
    const line = digestStep(rec({ action: { kind: "navigate", url: "https://x.test/apply" } }));
    expect(line).toContain("https://x.test/apply");
  });

  it("never emits a newline — one step is one line", () => {
    expect(digestStep(rec({ effect: "a\nb\nc" }))).not.toContain("\n");
  });
});

describe("compactHistory", () => {
  it("keeps the most recent page tree and drops earlier ones", () => {
    const out = compactHistory(
      [rec(), rec(), rec()],
      ["<tree 1 — 2000 chars>", "<tree 2>", "<tree 3 — current>"],
    );
    expect(out).toContain("<tree 3 — current>");
    expect(out).not.toContain("<tree 1");
    expect(out).not.toContain("<tree 2");
  });

  it("keeps every step line — the action history is what the model reasons over", () => {
    const steps = Array.from({ length: 30 }, (_, i) => rec({ effect: `change ${i}` }));
    const out = compactHistory(steps, ["<tree>"]);
    expect(out).toContain("change 0");
    expect(out).toContain("change 29");
  });

  it("stays small even after many steps", () => {
    const steps = Array.from({ length: 40 }, () => rec());
    const trees = Array.from({ length: 40 }, (_, i) => `<tree ${i}>`.padEnd(2000, "."));
    // 40 raw trees would be ~80KB. One tree plus 40 short lines is a fraction of that.
    expect(compactHistory(tools.steps, trees).length).toBeLessThan(8000);
  });

  it("handles an empty history", () => {
    expect(compactHistory([], ["<tree>"])).toContain("<tree>");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/orchestrator/digest.test.ts` — expect FAIL, cannot resolve `./digest.js`.

- [ ] **Step 3: Create `src/orchestrator/digest.ts`**

```ts
import type { StepRecord } from "./types.js";

const MAX_VALUE = 60;
const MAX_EFFECT = 80;

const clip = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) + "…" : s;

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** One step as one line. Never multi-line — the history is scanned, not read. */
export function digestStep(step: StepRecord): string {
  const a = step.action;
  const head =
    a.kind === "navigate"
      ? `navigate ${clip(a.url, MAX_VALUE)}`
      : a.kind === "fill" || a.kind === "select"
        ? `${a.kind} ${a.ref} "${clip(a.value, MAX_VALUE)}"`
        : a.kind === "upload"
          ? `upload ${a.ref} ${clip(a.path, MAX_VALUE)}`
          : "ref" in a
            ? `${a.kind} ${a.ref}`
            : a.kind;

  const tail =
    step.outcome.kind === "ok"
      ? `→ ${clip(flat(step.effect), MAX_EFFECT)}`
      : `✗ ${step.outcome.kind}: ${clip(flat(step.outcome.reason), MAX_EFFECT)}`;

  return `${head} ${tail}`;
}

/**
 * Build the model's view of the run so far (spec §8.3).
 *
 * Keeps every action line — that is the reasoning substrate — but only the
 * CURRENT page tree. Older trees describe a page that no longer exists, so they
 * cost input tokens and actively mislead.
 */
export function compactHistory(steps: StepRecord[], trees: string[]): string {
  const current = trees.length > 0 ? trees[trees.length - 1]! : "";
  const lines = steps.map((s, i) => `${i + 1}. ${digestStep(s)}`);
  return [
    lines.length > 0 ? "## What you have done so far\n" + lines.join("\n") : "## No steps yet",
    "\n## Current page\n" + current,
  ].join("\n");
}
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run src/orchestrator/digest.test.ts` — expect PASS, 10 tests.

```bash
git add src/orchestrator/digest.ts src/orchestrator/digest.test.ts
git commit -m "feat(orchestrator): history compaction"
```

---

### Task P2-3: Failure classification

**Files:** Create `src/orchestrator/classify.ts`, test `src/orchestrator/classify.test.ts`

Spec §8.4. Collapsing these into one `catch` is how agents get stuck in loops.

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classify } from "./classify.js";
import { StaleRefError, SubmitCapableError } from "../hands/browser/act.js";
import { ApprovalDeniedError } from "../hands/execute.js";

describe("classify", () => {
  it("stale ref is a FREE retry — nothing executed", () => {
    expect(classify(new StaleRefError("g1-r3")).kind).toBe("retry-free");
  });

  it("a refused click on a submit control is a chargeable retry", () => {
    // The model mislabelled its own action. Tell it, charge it, let it correct.
    expect(classify(new SubmitCapableError("g1-r9")).kind).toBe("retry");
  });

  it("approval denied is STUCK, not failed — the human is the blocker", () => {
    const out = classify(new ApprovalDeniedError({ kind: "submit", ref: "g1-r9" }));
    expect(out.kind).toBe("stuck");
  });

  it("a validation rejection is a chargeable retry", () => {
    expect(classify(new Error("malformed ref")).kind).toBe("retry");
  });

  it("a login wall is STUCK", () => {
    expect(classify(new Error("Login required to continue")).kind).toBe("stuck");
  });

  it("a CAPTCHA is STUCK and never attempted", () => {
    expect(classify(new Error("Please complete the reCAPTCHA")).kind).toBe("stuck");
  });

  it("a navigation timeout is a chargeable retry", () => {
    expect(classify(new Error("Timeout 30000ms exceeded")).kind).toBe("retry");
  });

  it("carries a human-readable reason through", () => {
    const out = classify(new Error("Timeout 30000ms exceeded"));
    if (out.kind === "ok") throw new Error("unreachable");
    expect(out.reason).toContain("Timeout");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/orchestrator/classify.test.ts` — expect FAIL.

- [ ] **Step 3: Create `src/orchestrator/classify.ts`**

```ts
import { StaleRefError, SubmitCapableError } from "../hands/browser/act.js";
import { ApprovalDeniedError } from "../hands/execute.js";
import type { StepOutcome } from "./types.js";

/** Page conditions only a human can clear (spec §7.5, §8.4). */
const NEEDS_HUMAN = /captcha|recaptcha|hcaptcha|sign in|log ?in required|login required|verify you are human/i;

/**
 * Map a thrown error to how the step should be accounted (spec §8.4).
 *
 * The distinction that matters is `retry-free` vs `retry`. A stale ref means the
 * page re-rendered between observe and act, so NOTHING executed — charging it
 * would let a re-render storm eat an objective's budget without work happening.
 * Every other retry represents a real attempt and is charged.
 */
export function classify(err: unknown): StepOutcome {
  if (err instanceof StaleRefError) {
    return { kind: "retry-free", reason: err.message };
  }
  if (err instanceof ApprovalDeniedError) {
    return { kind: "stuck", reason: `approval denied for ${err.effect.kind}` };
  }
  if (err instanceof SubmitCapableError) {
    // The model called a submit a click. Correctable — tell it and charge it.
    return { kind: "retry", reason: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);
  if (NEEDS_HUMAN.test(message)) {
    return { kind: "stuck", reason: message };
  }
  return { kind: "retry", reason: message };
}
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run src/orchestrator/classify.test.ts` — expect PASS, 8 tests.

```bash
git add src/orchestrator/classify.ts src/orchestrator/classify.test.ts
git commit -m "feat(orchestrator): failure taxonomy"
```

---

### Task P2-4: Budget accounting

**Files:** Create `src/orchestrator/budget.ts`, test `src/orchestrator/budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/orchestrator/budget.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BudgetTracker } from "./budget.js";

const t = () => new BudgetTracker({ maxSteps: 3, maxCost: 1.0 });

describe("BudgetTracker", () => {
  it("starts with budget remaining", () => {
    expect(t().exhausted()).toBeNull();
  });

  it("charges ordinary steps", () => {
    const b = t();
    b.record({ kind: "ok" });
    b.record({ kind: "ok" });
    expect(b.steps).toBe(2);
    expect(b.exhausted()).toBeNull();
  });

  it("reports exhaustion once the step ceiling is reached", () => {
    const b = t();
    for (let i = 0; i < 3; i++) b.record({ kind: "ok" });
    expect(b.exhausted()).toMatch(/step/i);
  });

  it("does NOT charge a stale-ref retry — nothing executed", () => {
    const b = t();
    for (let i = 0; i < 10; i++) b.record({ kind: "retry-free", reason: "stale" });
    expect(b.steps).toBe(0);
    expect(b.exhausted()).toBeNull();
  });

  it("still counts free retries for reporting", () => {
    const b = t();
    b.record({ kind: "retry-free", reason: "stale" });
    expect(b.freeRetries).toBe(1);
  });

  it("charges an ordinary retry", () => {
    const b = t();
    b.record({ kind: "retry", reason: "not found" });
    expect(b.steps).toBe(1);
  });

  it("reports exhaustion once the cost ceiling is reached", () => {
    const b = t();
    b.spend(0.6);
    b.spend(0.5);
    expect(b.exhausted()).toMatch(/cost/i);
  });

  it("caps runaway free retries so a re-render storm cannot spin forever", () => {
    const b = t();
    for (let i = 0; i < 200; i++) b.record({ kind: "retry-free", reason: "stale" });
    expect(b.exhausted()).toMatch(/re-render|stale/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/orchestrator/budget.test.ts` — expect FAIL.

- [ ] **Step 3: Create `src/orchestrator/budget.ts`**

```ts
import type { Objective, StepOutcome } from "./types.js";

/**
 * Free retries do not consume the step budget, so they need their own ceiling —
 * otherwise a page that re-renders on every observation spins forever at zero
 * recorded cost. This is generous: real staleness resolves in one or two.
 */
const MAX_FREE_RETRIES = 25;

export class BudgetTracker {
  steps = 0;
  freeRetries = 0;
  cost = 0;

  constructor(private readonly limits: Pick<Objective, "maxSteps" | "maxCost">) {}

  record(outcome: StepOutcome): void {
    if (outcome.kind === "retry-free") {
      this.freeRetries += 1;
      return;
    }
    this.steps += 1;
  }

  spend(usd: number): void {
    this.cost += usd;
  }

  /** Why the objective must stop, or null if it may continue. */
  exhausted(): string | null {
    if (this.steps >= this.limits.maxSteps) {
      return `step budget exhausted (${this.steps}/${this.limits.maxSteps})`;
    }
    if (this.cost >= this.limits.maxCost) {
      return `cost budget exhausted ($${this.cost.toFixed(2)}/$${this.limits.maxCost.toFixed(2)})`;
    }
    if (this.freeRetries >= MAX_FREE_RETRIES) {
      return `too many stale-ref re-renders (${this.freeRetries}) — the page will not settle`;
    }
    return null;
  }
}
```

- [ ] **Step 4: Run and commit**

Run: `npx vitest run src/orchestrator/budget.test.ts` — expect PASS, 8 tests.

```bash
git add src/orchestrator/budget.ts src/orchestrator/budget.test.ts
git commit -m "feat(orchestrator): budget accounting with free stale-ref retries"
```

---

### Task P2-5: Brain seam and tools

**Files:** Create `src/brains/types.ts`, `src/brains/tools.ts`, `src/brains/scripted-brain.ts`, test `src/brains/tools.test.ts`

- [ ] **Step 1: Create `src/brains/types.ts`**

```ts
import type { Objective, ObjectiveResult, StepRecord } from "../orchestrator/types.js";
import type { Effect } from "../hands/types.js";

/** What a brain can ask the world to do. Implemented over GatedExecutor. */
export interface BrainTools {
  readPage(): Promise<string>;
  capturePage(): Promise<{ base64: string }>;
  perform(effect: Effect): Promise<string>;
  /**
   * Every step taken this objective, oldest first.
   *
   * Lives here rather than inside the brain because `perform()` is what learns
   * each outcome. A brain that kept its own array would compact an empty
   * history and never see a `stuck` step — the array would be written by the
   * tools and read by nobody.
   */
  readonly steps: StepRecord[];
}

/**
 * Drives one objective to a terminal state.
 *
 * The seam exists so the orchestrator's behaviour can be tested with a scripted
 * implementation — there is no ANTHROPIC_API_KEY in this environment, and a
 * design that can only be exercised with one is a design that goes untested.
 */
export interface ActBrain {
  pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult>;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/brains/tools.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeTools } from "./tools.js";
import { ApprovalDeniedError } from "../hands/execute.js";
import { StaleRefError } from "../hands/browser/act.js";

const deps = (over: Partial<Parameters<typeof makeTools>[0]> = {}) => ({
  runEffect: vi.fn(async () => {}),
  readPage: vi.fn(async () => "g1-r0 button \"Apply\""),
  capturePage: vi.fn(async () => ({ base64: "AAA" })),
  onStep: vi.fn(),
  ...over,
});

describe("makeTools", () => {
  it("performs a valid effect and reports success", async () => {
    const d = deps();
    const out = await makeTools(d).perform({ kind: "fill", ref: "g1-r2", value: "Andes" });
    expect(d.runEffect).toHaveBeenCalledOnce();
    expect(out).toMatch(/ok|done|filled/i);
  });

  it("turns a denied approval into a RESULT, not an exception", async () => {
    // The model must be able to read "declined" and stop, not crash the run.
    const d = deps({
      runEffect: vi.fn(async () => {
        throw new ApprovalDeniedError({ kind: "submit", ref: "g1-r9" });
      }),
    });
    const out = await makeTools(d).perform({ kind: "submit", ref: "g1-r9" });
    expect(out).toMatch(/declined|denied/i);
    expect(out).toMatch(/do not retry/i);
  });

  it("turns a stale ref into a result telling the model to re-observe", async () => {
    const d = deps({
      runEffect: vi.fn(async () => { throw new StaleRefError("g1-r3"); }),
    });
    const out = await makeTools(d).perform({ kind: "click", ref: "g1-r3" });
    expect(out).toMatch(/re-?observe|read the page again/i);
  });

  it("reports each step's outcome to onStep for the history", async () => {
    const d = deps();
    await makeTools(d).perform({ kind: "click", ref: "g1-r1" });
    expect(d.onStep).toHaveBeenCalledOnce();
  });

  it("accumulates steps on the tools object for the brain to compact", async () => {
    const t = makeTools(deps());
    await t.perform({ kind: "click", ref: "g1-r1" });
    await t.perform({ kind: "fill", ref: "g1-r2", value: "x" });
    expect(t.steps).toHaveLength(2);
  });

  it("reports failures to onStep too", async () => {
    const d = deps({
      runEffect: vi.fn(async () => { throw new StaleRefError("g1-r3"); }),
    });
    await makeTools(d).perform({ kind: "click", ref: "g1-r3" });
    expect(d.onStep).toHaveBeenCalledOnce();
    expect(d.onStep.mock.calls[0]![0].outcome.kind).toBe("retry-free");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/brains/tools.test.ts` — expect FAIL.

- [ ] **Step 4: Create `src/brains/tools.ts`**

```ts
import { classify } from "../orchestrator/classify.js";
import type { StepRecord } from "../orchestrator/types.js";
import type { Effect } from "../hands/types.js";
import type { BrainTools } from "./types.js";

export interface ToolDeps {
  runEffect: (effect: Effect) => Promise<void>;
  readPage: () => Promise<string>;
  capturePage: () => Promise<{ base64: string }>;
  onStep: (record: StepRecord) => void;
}

/**
 * Wrap the executor as tools a brain can call.
 *
 * Errors become tool RESULTS rather than exceptions. The SDK's tool runner feeds
 * a result string back to the model, so a denial or a stale ref becomes
 * information it can act on — the documented human-in-the-loop pattern. Throwing
 * would abort the whole run over a recoverable step.
 */
export function makeTools(deps: ToolDeps): BrainTools {
  const steps: StepRecord[] = [];
  const record = (r: StepRecord) => { steps.push(r); deps.onStep(r); };

  return {
    steps,
    readPage: deps.readPage,
    capturePage: deps.capturePage,

    async perform(effect: Effect): Promise<string> {
      try {
        await deps.runEffect(effect);
        const effectText = `${effect.kind} ok`;
        record({ action: effect, outcome: { kind: "ok" }, effect: effectText });
        return `ok — ${effectText}`;
      } catch (err) {
        const outcome = classify(err);
        record({ action: effect, outcome, effect: "" });

        if (outcome.kind === "stuck") {
          return `DECLINED: ${outcome.reason}. Do not retry this. Stop and explain what you were trying to do.`;
        }
        if (outcome.kind === "retry-free") {
          return `STALE: ${outcome.reason} Read the page again to get fresh refs, then re-observe before acting.`;
        }
        return `ERROR: ${outcome.reason}`;
      }
    },
  };
}
```

- [ ] **Step 5: Create `src/brains/scripted-brain.ts`**

```ts
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
```

- [ ] **Step 6: Run and commit**

Run: `npx vitest run src/brains/tools.test.ts` — expect PASS, 6 tests. Then `npm test` and `npm run typecheck`.

```bash
git add src/brains/types.ts src/brains/tools.ts src/brains/scripted-brain.ts src/brains/tools.test.ts
git commit -m "feat(brains): tool surface and scripted brain"
```

---

### Task P2-6: Claude ActBrain

**Files:** Create `src/brains/act-brain.ts`

**Cannot be run without `ANTHROPIC_API_KEY`.** Write it, typecheck it, and report that live verification is outstanding. Do not attempt an API call.

- [ ] **Step 1: Install the SDK**

Run: `npm i @anthropic-ai/sdk`

- [ ] **Step 2: Create `src/brains/act-brain.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { BudgetTracker } from "../orchestrator/budget.js";
import { compactHistory } from "../orchestrator/digest.js";
import type { Objective, ObjectiveResult } from "../orchestrator/types.js";
import type { ActBrain, BrainTools } from "./types.js";

const SYSTEM = `You fill out job application forms in a real browser on behalf of a real person.

You see the page as a list of elements, each with a stable ref like "g1787291892-r26".
Always act by ref. Never guess a ref that is not in the current listing.

Rules that are enforced, not advisory:
- A "STALE" result means the page re-rendered and NOTHING happened. Call read_page
  again for fresh refs, then continue. This costs you nothing.
- Clicking an element that submits a form is REFUSED. Use the submit tool instead,
  which asks the human first.
- A "DECLINED" result means the human said no. Do not retry it. Stop and explain.

Fill only fields you have been given values for. If a required field has no value,
stop and say which field is missing rather than inventing one.`;

/** Every readPage result seen this objective, newest last. Only the last is sent. */
type Trees = string[];

export class ClaudeActBrain implements ActBrain {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    // Zero-arg constructor resolves ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN,
    // then an `ant auth login` profile — no key in the environment is not the
    // same as no credentials.
    this.client = client ?? new Anthropic();
  }

  async pursue(objective: Objective, tools: BrainTools): Promise<ObjectiveResult> {
    const budget = new BudgetTracker(objective);
    const trees: Trees = [];

    const readPage = betaZodTool({
      name: "read_page",
      description: "Read the current page as a list of elements with refs. Call this first, and again after anything changes the page.",
      inputSchema: z.object({}),
      run: async () => {
        const tree = await tools.readPage();
        trees.push(tree);
        return tree;
      },
    });

    const fill = betaZodTool({
      name: "fill",
      description: "Type a value into a text field, by ref.",
      inputSchema: z.object({ ref: z.string(), value: z.string() }),
      run: ({ ref, value }) => tools.perform({ kind: "fill", ref, value }),
    });

    const select = betaZodTool({
      name: "select",
      description: "Choose an option in a dropdown, by ref.",
      inputSchema: z.object({ ref: z.string(), value: z.string() }),
      run: ({ ref, value }) => tools.perform({ kind: "select", ref, value }),
    });

    const click = betaZodTool({
      name: "click",
      description: "Click a non-submitting element, by ref. Refused for anything that submits a form.",
      inputSchema: z.object({ ref: z.string() }),
      run: ({ ref }) => tools.perform({ kind: "click", ref }),
    });

    const submit = betaZodTool({
      name: "submit",
      description: "Submit the form. Always asks the human for approval first, and may be declined.",
      inputSchema: z.object({ ref: z.string() }),
      run: ({ ref }) => tools.perform({ kind: "submit", ref }),
    });

    const runner = this.client.beta.messages.toolRunner({
      model: "claude-opus-5",
      max_tokens: 8000,
      // Simple, high-volume decisions: fewer consolidated tool calls, less preamble.
      output_config: { effort: "low" },
      thinking: { type: "adaptive" },
      // Stable prefix: system prompt + tool definitions are resent every turn.
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      max_iterations: objective.maxSteps,
      tools: [readPage, fill, select, click, submit],
      messages: [{ role: "user", content: objective.goal }],
    });

    let stuckReason: string | null = null;

    for await (const message of runner) {
      const usage = message.usage as { cost?: number } | undefined;
      if (typeof usage?.cost === "number") budget.spend(usage.cost);

      const reason = budget.exhausted();
      if (reason) { stuckReason = reason; break; }

      // §8.3: replace the accumulated transcript with a compacted view. Older
      // page trees describe a page that no longer exists — they cost tokens and
      // actively mislead.
      if (trees.length > 1) {
        runner.setMessagesParams([
          { role: "user", content: `${objective.goal}\n\n${compactHistory(steps, trees)}` },
        ]);
      }
    }

    if (stuckReason) {
      return { kind: "stuck", reason: stuckReason, steps: budget.steps, cost: budget.cost };
    }
    const stuck = tools.steps.find((s) => s.outcome.kind === "stuck");
    if (stuck && stuck.outcome.kind === "stuck") {
      return { kind: "stuck", reason: stuck.outcome.reason, steps: budget.steps, cost: budget.cost };
    }
    return { kind: "done", steps: budget.steps, cost: budget.cost };
  }
}
```

- [ ] **Step 3: Typecheck and commit**

Run: `npm run typecheck` — expect exit 0. Do **not** run it.

#### ⚠️ The compaction step is the unverified part of this plan

Rewriting the transcript mid-run with `setMessagesParams()` is the one thing here
I could not check against a live SDK, and there is a specific reason to doubt it:
the Messages API requires every `tool_use` block to be answered by a matching
`tool_result`. Replacing the whole array with a single user message discards that
pairing, and the API may reject it outright.

**Stop and report — do not work around it — if any of these is true:**

- `setMessagesParams`, `max_iterations`, `output_config`, or `cache_control` are
  absent from the runner's types in the installed SDK version. Do not cast them
  away: a silently ignored option means compaction or the budget never takes
  effect, and nothing would look wrong.
- The types accept the call but the shape above is obviously invalid.

If compaction cannot work through the runner, the fallback is the manual loop
(documented in the SDK's tool-use guide), where we own the message array outright
and §8.3 becomes straightforward. That is a real possibility, not a failure —
report it and the plan will be revised rather than patched.

Everything else in this task is ordinary wiring and should be uncontroversial.

```bash
git add src/brains/act-brain.ts package.json package-lock.json
git commit -m "feat(brains): Claude ActBrain over the SDK tool runner"
```

---

### Task P2-7: Wire `do` into the CLI

**Files:** Modify `src/cli/spine.ts`

- [ ] **Step 1: Add the command**

Add to the imports:

```ts
import { makeTools } from "../brains/tools.js";
import { ScriptedBrain } from "../brains/scripted-brain.js";
import { ClaudeActBrain } from "../brains/act-brain.js";
import { DEFAULT_OBJECTIVE, type StepRecord } from "../orchestrator/types.js";
```

Add to `HELP`:

```
  do <goal>            let the brain pursue a goal (needs ANTHROPIC_API_KEY)
  demo                 run a scripted objective — no API key needed
```

Add before the REPL loop:

```ts
const steps: StepRecord[] = [];
const brainTools = makeTools({
  runEffect: (effect) => executor.runEffect(effect),
  readPage: async () => {
    inFlight = { kind: "readPage" };
    return renderSnapshot(await executor.observe({ kind: "readPage" }, () => readPage(session.page)));
  },
  capturePage: async () => {
    inFlight = { kind: "capturePage" };
    return executor.observe({ kind: "capturePage" }, () => capturePage(session.page));
  },
  onStep: (r) => steps.push(r),
});
```

Add to the command dispatch, before the effect parsing:

```ts
    if (cmd === "do" || cmd === "demo") {
      const goal = rest.join(" ");
      const brain =
        cmd === "demo"
          ? new ScriptedBrain([{ kind: "fill", ref: rest[0]!, value: rest.slice(1).join(" ") }])
          : new ClaudeActBrain();
      steps.length = 0;
      const result = await brain.pursue({ ...DEFAULT_OBJECTIVE, goal }, brainTools);
      console.log(
        `\n${result.kind.toUpperCase()} — ${result.steps} steps, $${result.cost.toFixed(4)}` +
          ("reason" in result ? `\n  ${result.reason}` : ""),
      );
      continue;
    }
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck` and `npm test` — both must be clean.

```bash
git add src/cli/spine.ts
git commit -m "feat(cli): do and demo commands"
```

---

## Done when

- `npm test` green (expect ~117 tests).
- `npm run typecheck` exit 0.
- `demo` drives a real form through the brain seam with no API key.
- `do` typechecks and is ready for a key.

**Outstanding, needs the author:** `ANTHROPIC_API_KEY` in `.env`, then `do "fill in my name and email"` against a real form, confirming the gate still fires at Submit with a model driving instead of a script.
