# Clippy Plan 1 — Spine (Browser Control + Trust) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI that attaches to a dedicated Chrome profile, reads a real job-application page as a ref'd element tree, and executes actions through a mechanical trust gate — proving or disproving the accessibility-tree assumption the whole architecture rests on.

**Architecture:** A plain Node/TypeScript CLI (no Electron yet — that is Plan 4). `hands/browser` connects over CDP via `playwright-core` and stamps every interactive element with a generation-scoped `data-clippy-ref` attribute during snapshot; actions cite those refs and fail loudly when the attribute is gone, which is what makes staleness detectable. `trust/` wraps every action in a gate check and an append-only audit log written *before* execution.

**Tech Stack:** TypeScript 5, Node 20+, `playwright-core` (CDP attach only — no bundled browser), `vitest`, `tsx`, `zod`.

**Spec:** `docs/superpowers/specs/2026-08-20-clippy-v1-design.md` — this plan implements §3.1, §6.1 (`hands/`, `trust/`), §7.1–7.3, §8.2, §8.4 (staleness half).

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Toolchain |
| `src/hands/types.ts` | `Action` union + `ToolMeta` flags (`reversible`, `outwardFacing`). The single source of truth both `trust/` and `hands/` read |
| `src/trust/policy.ts` | `isGated()` — pure predicate. **Written by the project author** |
| `src/trust/audit.ts` | Append-only JSONL audit log; write-before-execute |
| `src/hands/browser/connect.ts` | Launch/attach the dedicated Chrome profile over CDP |
| `src/hands/browser/snapshot.ts` | `readPage()` — stamp refs, extract the tree |
| `src/hands/browser/act.ts` | `click` / `fill` / `navigate` by ref, with stale rejection |
| `src/hands/browser/capture.ts` | `capturePage()` — full-page screenshot (spec §8.2) |
| `src/hands/execute.ts` | Ties `trust` + `hands`: gate → audit → execute |
| `src/cli/spine.ts` | Interactive REPL harness for driving all of the above by hand |
| `scripts/capture-fixture.ts` | Saves a real ATS page to `tests/fixtures/` for offline tests |

**Boundary rule:** `trust/` never imports from `hands/browser/`. It depends only on `hands/types.ts`. This keeps the gate testable with zero browser and prevents the safety layer from growing browser-specific special cases.

---

### Task 1: Toolchain scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "clippy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "spine": "tsx src/cli/spine.ts",
    "capture-fixture": "tsx scripts/capture-fixture.ts"
  },
  "dependencies": {
    "playwright-core": "^1.49.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
}
```

`noUncheckedIndexedAccess` matters here: the ref table is index-heavy and this forces the stale-ref case to be handled at every lookup rather than crashing at runtime.

`DOM.Iterable` is required, not optional: `stampAndCollect` (Task 6) iterates `querySelectorAll`
results with `for...of`, and `NodeListOf<Element>` only gains a `Symbol.iterator` when it is in
`lib`. Without it typecheck fails with `TS2488`.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `.nvmrc`**

```
20
```

- [ ] **Step 5: Install and verify**

Run: `npm install`
Expected: install completes, exit 0.

Do **not** run `typecheck` yet: `src/` does not exist, so the tsconfig `include`
globs match nothing and `tsc` exits non-zero with `TS18003: No inputs were found`.
That is correct behaviour, not a misconfiguration. Task 2 creates the first source
file; typecheck is verified there.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .nvmrc
git commit -m "chore: scaffold TypeScript toolchain"
```

---

### Task 2: Action types and tool metadata

**Files:**
- Create: `src/hands/types.ts`
- Test: `src/hands/types.test.ts`

This is the contract both `trust/` and `hands/` read. Spec §7.1 requires the reversible/outward-facing flags to be **static properties of the tool**, not something a model decides per call.

- [ ] **Step 1: Write the failing test**

Create `src/hands/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TOOL_META, type Action } from "./types.js";

describe("TOOL_META", () => {
  it("declares metadata for every action kind", () => {
    const kinds: Action["kind"][] = [
      "navigate", "click", "fill", "select", "upload",
      "readPage", "capturePage", "submit",
    ];
    for (const k of kinds) {
      expect(TOOL_META[k], `missing meta for ${k}`).toBeDefined();
    }
  });

  it("marks submit as outward-facing and irreversible", () => {
    expect(TOOL_META.submit).toEqual({ reversible: false, outwardFacing: true });
  });

  it("marks observation actions as reversible and internal", () => {
    expect(TOOL_META.readPage).toEqual({ reversible: true, outwardFacing: false });
    expect(TOOL_META.capturePage).toEqual({ reversible: true, outwardFacing: false });
  });

  it("marks fill as reversible and internal", () => {
    expect(TOOL_META.fill).toEqual({ reversible: true, outwardFacing: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hands/types.test.ts`
Expected: FAIL — `Failed to resolve import "./types.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/hands/types.ts`:

```ts
/** A generation-scoped element reference, e.g. "g3-r12". Only valid within its generation. */
export type Ref = string;

export type Action =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: Ref }
  | { kind: "fill"; ref: Ref; value: string }
  | { kind: "select"; ref: Ref; value: string }
  | { kind: "upload"; ref: Ref; path: string }
  | { kind: "readPage" }
  | { kind: "capturePage" }
  | { kind: "submit"; ref: Ref };

export interface ToolMeta {
  /** Can the effect be undone without contacting anyone? */
  reversible: boolean;
  /** Does this send something to a third party under the user's name? */
  outwardFacing: boolean;
}

/**
 * Static per-tool safety metadata (spec §7.1).
 *
 * These are properties of the TOOL, never of the call. A model is not consulted
 * about them and cannot influence them. Adding a new Action kind without adding
 * a row here is a type error, which is the point.
 */
export const TOOL_META: Record<Action["kind"], ToolMeta> = {
  navigate:    { reversible: true,  outwardFacing: false },
  click:       { reversible: true,  outwardFacing: false },
  fill:        { reversible: true,  outwardFacing: false },
  select:      { reversible: true,  outwardFacing: false },
  upload:      { reversible: true,  outwardFacing: false },
  readPage:    { reversible: true,  outwardFacing: false },
  capturePage: { reversible: true,  outwardFacing: false },
  submit:      { reversible: false, outwardFacing: true  },
};
```

Note `click` is reversible: clicking a checkbox or a "Next" tab is undoable. The genuinely irreversible click — the one that posts the application — is a distinct `submit` kind precisely so the gate can catch it by type rather than by guessing from a label.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hands/types.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hands/types.ts src/hands/types.test.ts
git commit -m "feat(hands): action types with static safety metadata"
```

---

### Task 3: The gate policy — `isGated()`

**Files:**
- Create: `src/trust/policy.ts`
- Test: `src/trust/policy.test.ts`

> **⚠️ AUTHOR CONTRIBUTION.** Steps 1–3 scaffold the file and write the tests. **Step 4's implementation is to be written by the project author, not the executing agent.** If you are an agent executing this plan, complete Steps 1–3, then stop and hand back with the tests failing.
>
> **Why this one:** `isGated()` is the safety boundary for the entire product (spec §7.1). It is ~6 lines of pure logic encoding a personal judgment about how much irreversibility is acceptable without a click. The trade-off is real in both directions: gate too little and a bad run submits something you can't retract; gate too much and you're clicking Approve 60 times per application, which trains you to stop reading the dialogs — a gate everyone rubber-stamps is worse than no gate, because it manufactures false confidence.
>
> **Things to weigh:** Should `outwardFacing` alone gate, or `!reversible` alone, or either? Is `upload` (attaching a file to a form that hasn't been submitted) genuinely reversible? Should there be a "dry run" mode that gates everything, for the first week of debugging?

- [ ] **Step 1: Write the failing test**

Create `src/trust/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isGated } from "./policy.js";
import type { Action } from "../hands/types.js";

const act = (a: Action) => a;

describe("isGated", () => {
  it("gates submit — outward-facing and irreversible", () => {
    expect(isGated(act({ kind: "submit", ref: "g1-r1" }))).toBe(true);
  });

  it("does not gate observation", () => {
    expect(isGated(act({ kind: "readPage" }))).toBe(false);
    expect(isGated(act({ kind: "capturePage" }))).toBe(false);
  });

  it("does not gate ordinary form interaction", () => {
    expect(isGated(act({ kind: "fill", ref: "g1-r2", value: "Andes" }))).toBe(false);
    expect(isGated(act({ kind: "click", ref: "g1-r3" }))).toBe(false);
    expect(isGated(act({ kind: "select", ref: "g1-r4", value: "Yes" }))).toBe(false);
  });

  it("does not gate navigation", () => {
    expect(isGated(act({ kind: "navigate", url: "https://boards.greenhouse.io/x" }))).toBe(false);
  });

  it("is a pure function of the action kind", () => {
    const a = act({ kind: "submit", ref: "g1-r1" });
    expect(isGated(a)).toBe(isGated(a));
  });
});
```

- [ ] **Step 2: Create the file with the signature and TODO marker**

Create `src/trust/policy.ts`:

```ts
import { TOOL_META, type Action } from "../hands/types.js";

/**
 * The safety boundary (spec §7.1).
 *
 * Returns true if `action` must not execute until a human has approved it.
 *
 * MUST be a pure function of the action's static TOOL_META. Never consult a
 * model, the page, or run state here — a confused or prompt-injected model has
 * to be structurally unable to reach an ungated Submit.
 *
 * TODO(author): implement. See the plan's Task 3 note for the trade-offs.
 */
export function isGated(action: Action): boolean {
  throw new Error("isGated not implemented — see docs/superpowers/plans, Task 3");
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/trust/policy.test.ts`
Expected: FAIL — all 5 tests throw `isGated not implemented`.

- [ ] **Step 4: 🧑 AUTHOR — implement `isGated`**

Replace the body in `src/trust/policy.ts`. A reference shape (the plan does **not** prescribe the predicate):

```ts
export function isGated(action: Action): boolean {
  const meta = TOOL_META[action.kind];
  return /* your policy here, in terms of meta.outwardFacing and meta.reversible */;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/trust/policy.test.ts`
Expected: PASS — 5 tests. If your policy intentionally gates more than the tests expect (e.g. you decided `upload` should gate), **update the tests to match your policy** and note why in the commit message — the tests encode the decision, so they should reflect it.

- [ ] **Step 6: Commit**

```bash
git add src/trust/policy.ts src/trust/policy.test.ts
git commit -m "feat(trust): gate policy"
```

---

### Task 4: Audit log

**Files:**
- Create: `src/trust/audit.ts`
- Test: `src/trust/audit.test.ts`

Spec §7.3: every entry is written **before** the action executes. A crash mid-action must leave evidence the action was attempted.

- [ ] **Step 1: Write the failing test**

Create `src/trust/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "clippy-audit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("AuditLog", () => {
  it("writes an attempt line before the action runs", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    await log.attempt({ kind: "fill", ref: "g1-r2", value: "Andes" }, { gated: false });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.phase).toBe("attempt");
    expect(entry.action.kind).toBe("fill");
    expect(entry.gated).toBe(false);
    expect(typeof entry.ts).toBe("number");
    expect(typeof entry.seq).toBe("number");
  });

  it("appends an outcome line after, sharing the attempt's seq", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    const seq = await log.attempt({ kind: "click", ref: "g1-r3" }, { gated: false });
    await log.outcome(seq, { ok: true });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ phase: "outcome", seq, ok: true });
  });

  it("records failures with the error message", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    const seq = await log.attempt({ kind: "click", ref: "g1-r9" }, { gated: false });
    await log.outcome(seq, { ok: false, error: "stale ref" });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({ ok: false, error: "stale ref" });
  });

  it("never rewrites earlier lines", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    const a = await log.attempt({ kind: "readPage" }, { gated: false });
    await log.outcome(a, { ok: true });
    const b = await log.attempt({ kind: "capturePage" }, { gated: false });
    await log.outcome(b, { ok: true });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]!).action.kind).toBe("readPage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/trust/audit.test.ts`
Expected: FAIL — `Failed to resolve import "./audit.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/trust/audit.ts`:

```ts
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
  #ready: Promise<void>;

  constructor(private readonly path: string) {
    this.#ready = mkdir(dirname(path), { recursive: true }).then(() => undefined);
  }

  async attempt(action: Action, meta: { gated: boolean }): Promise<number> {
    await this.#ready;
    const seq = ++this.#seq;
    await this.#write({ phase: "attempt", seq, ts: Date.now(), action, gated: meta.gated });
    return seq;
  }

  async outcome(seq: number, outcome: Outcome): Promise<void> {
    await this.#ready;
    await this.#write({ phase: "outcome", seq, ts: Date.now(), ...outcome });
  }

  async #write(entry: Record<string, unknown>): Promise<void> {
    await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/trust/audit.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/trust/audit.ts src/trust/audit.test.ts
git commit -m "feat(trust): append-only audit log, write-before-execute"
```

---

### Task 5: Chrome connection

**Files:**
- Create: `src/hands/browser/connect.ts`

Spec §3.1: a **dedicated** Chrome profile, signed into job boards only. Not your primary profile.

- [ ] **Step 1: Write the implementation**

No unit test — this is I/O against a real browser, verified manually in Step 2 and exercised by every later task.

Create `src/hands/browser/connect.ts`:

```ts
import { chromium, type Browser, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222;
/** Dedicated profile — NOT the user's primary Chrome data dir (spec §3.1). */
export const PROFILE_DIR = join(homedir(), ".clippy", "chrome-profile");

/** Launch the dedicated profile with the debugging port open. Detached: survives the CLI. */
export function launchChrome(): void {
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
  ], { detached: true, stdio: "ignore" });
  child.unref();
}

export interface Session {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

/** Attach to the already-running dedicated profile. Throws with guidance if it isn't up. */
export async function connect(): Promise<Session> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (cause) {
    throw new Error(
      `No Chrome on port ${PORT}. Start it with: npm run spine -- --launch`,
      { cause },
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return {
    browser,
    page,
    // On a connectOverCDP browser, close() tears down OUR connection and leaves
    // Chrome running. That is what we want — the user's login sessions live in
    // that process and must survive the CLI exiting.
    close: async () => { await browser.close(); },
  };
}
```

- [ ] **Step 2: Verify manually**

Run:
```bash
npx tsx -e "import {launchChrome} from './src/hands/browser/connect.js'; launchChrome()"
```
Expected: a new Chrome window opens with a fresh, signed-out profile. Confirm it is **not** your normal profile — no bookmarks, no logged-in accounts.

Then:
```bash
npx tsx -e "import {connect} from './src/hands/browser/connect.js'; const s = await connect(); console.log(await s.page.title()); await s.close()"
```
Expected: prints the page title (likely `New Tab`) and exits 0.

- [ ] **Step 3: Sign in to a job board**

In that Chrome window, sign in to one ATS you can reach a real application form on (Greenhouse, Lever, or Workday). This profile persists at `~/.clippy/chrome-profile`, so this is a one-time step.

- [ ] **Step 4: Commit**

```bash
git add src/hands/browser/connect.ts
git commit -m "feat(hands): CDP connection to dedicated Chrome profile"
```

---

### Task 6: `readPage()` — the ref'd snapshot

**Files:**
- Create: `src/hands/browser/snapshot.ts`
- Test: `src/hands/browser/snapshot.test.ts`

The core mechanism. Every interactive element gets `data-clippy-ref="g{N}-r{i}"` stamped in one `page.evaluate` pass. Because the generation is baked into the attribute value, a ref from generation 3 simply cannot be found once generation 4 has been stamped — staleness detection falls out of the selector, with no bookkeeping.

- [ ] **Step 1: Write the failing test**

Create `src/hands/browser/snapshot.test.ts`. This tests the pure browser-side function in isolation, so no browser is needed:

```ts
import { describe, it, expect } from "vitest";
import { stampAndCollect } from "./snapshot.js";

import { parseHTML } from "linkedom";

/** Real DOM semantics in Node, no browser — see Step 2 for the dependency. */
function fakeDoc(html: string): Document {
  return parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
}

describe("stampAndCollect", () => {
  it("stamps each interactive element with a generation-scoped ref", () => {
    const doc = fakeDoc(`<input id="a"><button id="b">Go</button>`);
    const nodes = stampAndCollect(doc, 3);
    expect(nodes.map((n) => n.ref)).toEqual(["g3-r0", "g3-r1"]);
    expect(doc.getElementById("a")!.getAttribute("data-clippy-ref")).toBe("g3-r0");
  });

  it("prefers the label element for the accessible name", () => {
    const doc = fakeDoc(`<label for="e">Email address</label><input id="e">`);
    expect(stampAndCollect(doc, 1)[0]!.name).toBe("Email address");
  });

  it("falls back to aria-label, then placeholder", () => {
    const aria = fakeDoc(`<input aria-label="Phone">`);
    expect(stampAndCollect(aria, 1)[0]!.name).toBe("Phone");
    const ph = fakeDoc(`<input placeholder="Your city">`);
    expect(stampAndCollect(ph, 1)[0]!.name).toBe("Your city");
  });

  it("uses trimmed text content for buttons and links", () => {
    const doc = fakeDoc(`<button>  Submit Application \n </button>`);
    expect(stampAndCollect(doc, 1)[0]!.name).toBe("Submit Application");
  });

  it("records role and current value", () => {
    const doc = fakeDoc(`<input type="email" value="a@b.c" aria-label="Email">`);
    const n = stampAndCollect(doc, 1)[0]!;
    expect(n.role).toBe("textbox");
    expect(n.value).toBe("a@b.c");
  });

  it("skips hidden and disabled elements", () => {
    const doc = fakeDoc(
      `<input aria-hidden="true"><input disabled><input type="hidden"><input aria-label="ok">`,
    );
    const nodes = stampAndCollect(doc, 1);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe("ok");
  });

  it("survives serialisation into a page context", () => {
    // readPage() ships this function to the browser as a STRING and rebuilds it
    // with new Function. Every other test in this file calls stampAndCollect
    // directly, where Node resolves module-scope bindings via closure — so those
    // tests CANNOT catch a stray outer reference. This one can: it exercises the
    // path production actually uses.
    const rebuilt = new Function(
      `return (${stampAndCollect.toString()})`,
    )() as typeof stampAndCollect;

    const doc = fakeDoc(`<input aria-label="Email"><button>Send</button>`);
    const nodes = rebuilt(doc, 7);
    expect(nodes.map((n) => n.ref)).toEqual(["g7-r0", "g7-r1"]);
    expect(nodes[0]!.name).toBe("Email");
    expect(nodes[1]!.name).toBe("Send");
  });

  it("re-stamping with a new generation invalidates old refs", () => {
    const doc = fakeDoc(`<input aria-label="x">`);
    stampAndCollect(doc, 1);
    stampAndCollect(doc, 2);
    expect(doc.querySelector(`[data-clippy-ref="g1-r0"]`)).toBeNull();
    expect(doc.querySelector(`[data-clippy-ref="g2-r0"]`)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Add the test-only DOM dependency**

Run: `npm i -D linkedom`
Expected: installs. `linkedom` parses HTML into a spec-compliant DOM in Node, which keeps `stampAndCollect` testable against fixture HTML with no browser.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/hands/browser/snapshot.test.ts`
Expected: FAIL — `Failed to resolve import "./snapshot.js"`.

- [ ] **Step 4: Write the implementation**

Create `src/hands/browser/snapshot.ts`:

```ts
import type { Page } from "playwright-core";
import type { Ref } from "../types.js";

export interface RefNode {
  ref: Ref;
  role: string;
  name: string;
  value?: string;
}

export interface Snapshot {
  generation: number;
  url: string;
  title: string;
  nodes: RefNode[];
}

/**
 * Stamp every interactive element with `data-clippy-ref` and collect its
 * role/name/value. Exported for testing — also serialised into the page.
 *
 * Pure with respect to everything except the `data-clippy-ref` attribute.
 */
export function stampAndCollect(doc: Document, generation: number): RefNode[] {
  // Declared INSIDE the function on purpose. readPage() serialises this
  // function with .toString() and rebuilds it inside the page, where nothing
  // from this module's scope exists. Hoisting this to module scope would throw
  // ReferenceError in the browser while every direct-call test still passed.
  const SELECTOR =
    "input, textarea, select, button, a[href], [role=button], [contenteditable=true]";

  for (const stale of doc.querySelectorAll("[data-clippy-ref]")) {
    stale.removeAttribute("data-clippy-ref");
  }

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "file";
    if (type === "submit") return "button";
    return "textbox";
  };

  const labelFor = (el: Element): Element | null => {
    const id = el.getAttribute("id");
    if (!id) return null;
    // Iterate rather than build a selector: CSS.escape does not exist in Node,
    // and this function is deliberately runnable under linkedom in tests.
    for (const label of doc.querySelectorAll("label[for]")) {
      if (label.getAttribute("for") === id) return label;
    }
    return null;
  };

  const nameOf = (el: Element): string => {
    const text = labelFor(el)?.textContent?.trim();
    if (text) return text;
    const aria = el.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    const placeholder = el.getAttribute("placeholder")?.trim();
    if (placeholder) return placeholder;
    return el.textContent?.trim().replace(/\s+/g, " ") ?? "";
  };

  const visible = (el: Element): boolean => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("type")?.toLowerCase() === "hidden") return false;
    return true;
  };

  const out: RefNode[] = [];
  let i = 0;
  for (const el of doc.querySelectorAll(SELECTOR)) {
    if (!visible(el)) continue;
    const ref = `g${generation}-r${i++}`;
    el.setAttribute("data-clippy-ref", ref);
    const value = (el as HTMLInputElement).value ?? el.getAttribute("value") ?? undefined;
    out.push({ ref, role: roleOf(el), name: nameOf(el), value: value || undefined });
  }
  return out;
}

let generation = 0;

/** Take a fresh ref'd snapshot of the page, bumping the generation (spec §8.2). */
export async function readPage(page: Page): Promise<Snapshot> {
  const gen = ++generation;
  const nodes: RefNode[] = await page.evaluate(
    ({ source, g }: { source: string; g: number }) => {
      const fn = new Function(`return (${source})`)() as (d: Document, n: number) => unknown;
      return fn(document, g);
    },
    { source: stampAndCollect.toString(), g: gen },
  ) as RefNode[];
  return { generation: gen, url: page.url(), title: await page.title(), nodes };
}

/** Compact text rendering for a model prompt (spec §8.2 — ~2KB, not pixels). */
export function renderSnapshot(s: Snapshot): string {
  const lines = s.nodes.map(
    (n) => `${n.ref} ${n.role} "${n.name}"${n.value ? ` = "${n.value}"` : ""}`,
  );
  return [`# ${s.title}`, `# ${s.url}`, ...lines].join("\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/hands/browser/snapshot.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/hands/browser/snapshot.ts src/hands/browser/snapshot.test.ts package.json package-lock.json
git commit -m "feat(hands): ref'd page snapshot with generation-scoped staleness"
```

---

### Task 7: Actions by ref, with stale rejection

**Files:**
- Create: `src/hands/browser/act.ts`
- Test: `src/hands/browser/act.test.ts`

Spec §8.4: an action whose ref belongs to an old generation must be **rejected**, never executed against whatever now occupies that position.

- [ ] **Step 1: Write the failing test**

Create `src/hands/browser/act.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { StaleRefError, performAction } from "./act.js";

/** Minimal Page stub: only what performAction touches. */
function fakePage(opts: { found: boolean }) {
  const calls: string[] = [];
  const locator = {
    count: async () => (opts.found ? 1 : 0),
    click: vi.fn(async () => { calls.push("click"); }),
    fill: vi.fn(async (v: string) => { calls.push(`fill:${v}`); }),
    selectOption: vi.fn(async (v: string) => { calls.push(`select:${v}`); }),
    setInputFiles: vi.fn(async (p: string) => { calls.push(`upload:${p}`); }),
  };
  return {
    page: {
      locator: () => locator,
      goto: vi.fn(async (u: string) => { calls.push(`goto:${u}`); }),
      waitForLoadState: vi.fn(async () => {}),
    } as any,
    locator,
    calls,
  };
}

describe("performAction", () => {
  it("clicks the element matching the ref", async () => {
    const { page, calls } = fakePage({ found: true });
    await performAction(page, { kind: "click", ref: "g1-r3" });
    expect(calls).toContain("click");
  });

  it("fills a value", async () => {
    const { page, calls } = fakePage({ found: true });
    await performAction(page, { kind: "fill", ref: "g1-r2", value: "Andes" });
    expect(calls).toContain("fill:Andes");
  });

  it("throws StaleRefError when the ref is not on the page", async () => {
    const { page } = fakePage({ found: false });
    await expect(
      performAction(page, { kind: "click", ref: "g1-r3" }),
    ).rejects.toBeInstanceOf(StaleRefError);
  });

  it("does NOT execute anything when the ref is stale", async () => {
    const { page, locator } = fakePage({ found: false });
    await performAction(page, { kind: "click", ref: "g1-r3" }).catch(() => {});
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("treats submit as a click on the referenced element", async () => {
    const { page, calls } = fakePage({ found: true });
    await performAction(page, { kind: "submit", ref: "g1-r9" });
    expect(calls).toContain("click");
  });

  it("navigates without needing a ref", async () => {
    const { page, calls } = fakePage({ found: false });
    await performAction(page, { kind: "navigate", url: "https://example.com" });
    expect(calls).toContain("goto:https://example.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hands/browser/act.test.ts`
Expected: FAIL — `Failed to resolve import "./act.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/hands/browser/act.ts`:

```ts
import type { Page } from "playwright-core";
import type { Action, Ref } from "../types.js";

/**
 * The ref no longer exists on the page (spec §8.4).
 *
 * Almost always means the page re-rendered since the snapshot. Recovery is
 * re-observe and retry the same intent — free, and does not count against the
 * step budget, because nothing was executed.
 */
export class StaleRefError extends Error {
  constructor(public readonly ref: Ref) {
    super(`Stale ref ${ref}: element no longer on the page. Re-observe and retry.`);
    this.name = "StaleRefError";
  }
}

async function resolve(page: Page, ref: Ref) {
  const locator = page.locator(`[data-clippy-ref="${ref}"]`);
  if ((await locator.count()) === 0) throw new StaleRefError(ref);
  return locator;
}

/** Execute one action. Throws StaleRefError BEFORE any side effect. */
export async function performAction(page: Page, action: Action): Promise<void> {
  switch (action.kind) {
    case "navigate":
      await page.goto(action.url, { waitUntil: "domcontentloaded" });
      break;
    case "click":
    case "submit":
      await (await resolve(page, action.ref)).click();
      break;
    case "fill":
      await (await resolve(page, action.ref)).fill(action.value);
      break;
    case "select":
      await (await resolve(page, action.ref)).selectOption(action.value);
      break;
    case "upload":
      await (await resolve(page, action.ref)).setInputFiles(action.path);
      break;
    case "readPage":
    case "capturePage":
      throw new Error(`${action.kind} is an observation — call it directly, not via performAction`);
  }
  await settle(page);
}

/** Wait for the page to stop moving before the next snapshot (spec §8.4). */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hands/browser/act.test.ts`
Expected: PASS — 6 tests. The fourth is the important one: it proves nothing executes on a stale ref.

- [ ] **Step 5: Commit**

```bash
git add src/hands/browser/act.ts src/hands/browser/act.test.ts
git commit -m "feat(hands): ref-based actions with stale-ref rejection"
```

---

### Task 8: `capturePage()`

**Files:**
- Create: `src/hands/browser/capture.ts`

Spec §8.2: full-page, downscaled, with a dimension cap.

- [ ] **Step 1: Write the implementation**

Create `src/hands/browser/capture.ts`:

```ts
import type { Page } from "playwright-core";

/** Hard ceiling on the stitched screenshot's height, in CSS pixels. */
const MAX_HEIGHT = 8000;

export interface Capture {
  /** PNG bytes, base64. Goes to ActBrain as a native image block — never to Jenova (spec §5). */
  base64: string;
  width: number;
  height: number;
  truncated: boolean;
}

/**
 * Full-page screenshot for comprehension (spec §8.2).
 *
 * The image is for DECIDING. Actions still cite refs from readPage(), never
 * coordinates read off this image.
 */
export async function capturePage(page: Page): Promise<Capture> {
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  const truncated = dims.height > MAX_HEIGHT;
  const height = Math.min(dims.height, MAX_HEIGHT);

  const buf = await page.screenshot({
    type: "png",
    ...(truncated
      ? { clip: { x: 0, y: 0, width: dims.width, height } }
      : { fullPage: true }),
  });

  return { base64: buf.toString("base64"), width: dims.width, height, truncated };
}
```

- [ ] **Step 2: Verify manually against a real page**

Run:
```bash
npx tsx -e "
import {connect} from './src/hands/browser/connect.js';
import {capturePage} from './src/hands/browser/capture.js';
import {writeFile} from 'node:fs/promises';
const s = await connect();
const c = await capturePage(s.page);
await writeFile('/tmp/clippy-capture.png', Buffer.from(c.base64,'base64'));
console.log(c.width, c.height, 'truncated:', c.truncated);
await s.close();
"
open /tmp/clippy-capture.png
```
Expected: prints dimensions; the PNG shows the **whole scrolled page**, not just the viewport.

- [ ] **Step 3: Commit**

```bash
git add src/hands/browser/capture.ts
git commit -m "feat(hands): full-page capture with dimension cap"
```

---

### Task 9: Gated execution

**Files:**
- Create: `src/hands/execute.ts`
- Test: `src/hands/execute.test.ts`

Where §7.1 and §7.3 meet: gate → audit → execute, in that order, with no way around it.

- [ ] **Step 1: Write the failing test**

Create `src/hands/execute.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { GatedExecutor, ApprovalDeniedError } from "./execute.js";
import type { Action } from "./types.js";

const fakeAudit = () => {
  const entries: string[] = [];
  return {
    entries,
    log: {
      attempt: vi.fn(async (a: Action, m: { gated: boolean }) => {
        entries.push(`attempt:${a.kind}:gated=${m.gated}`);
        return entries.length;
      }),
      outcome: vi.fn(async (seq: number, o: { ok: boolean }) => {
        entries.push(`outcome:${seq}:${o.ok}`);
      }),
    } as any,
  };
};

describe("GatedExecutor", () => {
  it("executes an ungated action without asking for approval", async () => {
    const { log } = fakeAudit();
    const perform = vi.fn(async () => {});
    const approve = vi.fn(async () => true);
    const ex = new GatedExecutor({ audit: log, perform, requestApproval: approve });

    await ex.run({ kind: "fill", ref: "g1-r1", value: "x" });
    expect(approve).not.toHaveBeenCalled();
    expect(perform).toHaveBeenCalledOnce();
  });

  it("asks for approval before a gated action", async () => {
    const { log } = fakeAudit();
    const perform = vi.fn(async () => {});
    const approve = vi.fn(async () => true);
    const ex = new GatedExecutor({ audit: log, perform, requestApproval: approve });

    await ex.run({ kind: "submit", ref: "g1-r9" });
    expect(approve).toHaveBeenCalledOnce();
    expect(perform).toHaveBeenCalledOnce();
  });

  it("does NOT execute when approval is denied", async () => {
    const { log } = fakeAudit();
    const perform = vi.fn(async () => {});
    const ex = new GatedExecutor({
      audit: log, perform, requestApproval: async () => false,
    });

    await expect(ex.run({ kind: "submit", ref: "g1-r9" }))
      .rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(perform).not.toHaveBeenCalled();
  });

  it("writes the audit attempt BEFORE performing", async () => {
    const { entries, log } = fakeAudit();
    const order: string[] = [];
    log.attempt = vi.fn(async () => { order.push("audit"); return 1; }) as any;
    const ex = new GatedExecutor({
      audit: log,
      perform: async () => { order.push("perform"); },
      requestApproval: async () => true,
    });

    await ex.run({ kind: "click", ref: "g1-r1" });
    expect(order).toEqual(["audit", "perform"]);
    expect(entries).toBeDefined();
  });

  it("records a failed outcome and rethrows", async () => {
    const { log } = fakeAudit();
    const ex = new GatedExecutor({
      audit: log,
      perform: async () => { throw new Error("boom"); },
      requestApproval: async () => true,
    });

    await expect(ex.run({ kind: "click", ref: "g1-r1" })).rejects.toThrow("boom");
    expect(log.outcome).toHaveBeenCalledWith(expect.any(Number), { ok: false, error: "boom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hands/execute.test.ts`
Expected: FAIL — `Failed to resolve import "./execute.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/hands/execute.ts`:

```ts
import { isGated } from "../trust/policy.js";
import type { AuditLog } from "../trust/audit.js";
import type { Action } from "./types.js";

export class ApprovalDeniedError extends Error {
  constructor(public readonly action: Action) {
    super(`Approval denied for ${action.kind}`);
    this.name = "ApprovalDeniedError";
  }
}

export interface GatedExecutorDeps {
  audit: AuditLog;
  perform: (action: Action) => Promise<void>;
  requestApproval: (action: Action) => Promise<boolean>;
}

/**
 * The single chokepoint every side effect passes through (spec §7.1, §7.3).
 *
 * Order is load-bearing: gate, then audit, then execute. Auditing after
 * execution would lose the record of an action that crashed the process,
 * which is precisely the case worth having a record of.
 */
export class GatedExecutor {
  constructor(private readonly deps: GatedExecutorDeps) {}

  async run(action: Action): Promise<void> {
    const gated = isGated(action);

    if (gated && !(await this.deps.requestApproval(action))) {
      const seq = await this.deps.audit.attempt(action, { gated });
      await this.deps.audit.outcome(seq, { ok: false, error: "approval denied" });
      throw new ApprovalDeniedError(action);
    }

    const seq = await this.deps.audit.attempt(action, { gated });
    try {
      await this.deps.perform(action);
      await this.deps.audit.outcome(seq, { ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.deps.audit.outcome(seq, { ok: false, error });
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hands/execute.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — all files green (types 4, policy 5, audit 4, snapshot 8, act 6, execute 5 = 32 tests).

- [ ] **Step 6: Commit**

```bash
git add src/hands/execute.ts src/hands/execute.test.ts
git commit -m "feat(hands): gated executor — gate, audit, then execute"
```

---

### Task 10: CLI harness

**Files:**
- Create: `src/cli/spine.ts`

A REPL for driving the spine by hand. This is how you answer the plan's actual question.

- [ ] **Step 1: Write the implementation**

Create `src/cli/spine.ts`:

```ts
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { connect, launchChrome } from "../hands/browser/connect.js";
import { readPage, renderSnapshot } from "../hands/browser/snapshot.js";
import { performAction } from "../hands/browser/act.js";
import { capturePage } from "../hands/browser/capture.js";
import { GatedExecutor } from "../hands/execute.js";
import { AuditLog } from "../trust/audit.js";
import type { Action } from "../hands/types.js";

const HELP = `
  read                 snapshot the page and print the ref'd tree
  shot                 full-page screenshot -> /tmp/clippy-capture.png
  go <url>             navigate
  click <ref>          click by ref
  fill <ref> <value>   fill by ref
  submit <ref>         click, but through the gate
  quit
`;

if (process.argv.includes("--launch")) {
  launchChrome();
  console.log("Chrome launching on :9222 with the dedicated profile.");
  process.exit(0);
}

const session = await connect();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const audit = new AuditLog(join(process.cwd(), "runs", `spine-${Date.now()}.jsonl`));

const executor = new GatedExecutor({
  audit,
  perform: (a) => performAction(session.page, a),
  requestApproval: async (a) => {
    const answer = await rl.question(`\n⏸  GATED: ${a.kind} ${JSON.stringify(a)}\n   approve? [y/N] `);
    return answer.trim().toLowerCase() === "y";
  },
});

console.log(HELP);

for (;;) {
  const line = (await rl.question("clippy> ")).trim();
  const [cmd, ...rest] = line.split(/\s+/);
  if (!cmd) continue;
  if (cmd === "quit") break;

  try {
    if (cmd === "read") {
      const snap = await readPage(session.page);
      console.log(renderSnapshot(snap));
      console.log(`\n(generation ${snap.generation}, ${snap.nodes.length} elements)`);
      continue;
    }
    if (cmd === "shot") {
      const c = await capturePage(session.page);
      const { writeFile } = await import("node:fs/promises");
      await writeFile("/tmp/clippy-capture.png", Buffer.from(c.base64, "base64"));
      console.log(`${c.width}x${c.height} truncated=${c.truncated} -> /tmp/clippy-capture.png`);
      continue;
    }

    const action: Action | null =
      cmd === "go"     ? { kind: "navigate", url: rest[0]! }
    : cmd === "click"  ? { kind: "click", ref: rest[0]! }
    : cmd === "submit" ? { kind: "submit", ref: rest[0]! }
    : cmd === "fill"   ? { kind: "fill", ref: rest[0]!, value: rest.slice(1).join(" ") }
    : null;

    if (!action) { console.log(HELP); continue; }
    await executor.run(action);
    console.log("ok");
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}

rl.close();
await session.close();
```

- [ ] **Step 2: Add the abort handler (spec §7.2)**

The global ⌥⇧Esc hotkey needs Electron and lands in Plan 4, but the *abort
semantics* it triggers belong here — releasing the browser and recording the
abort. In the CLI, Ctrl-C is the trigger. Insert before the `for (;;)` loop in
`src/cli/spine.ts`:

```ts
let aborting = false;
process.on("SIGINT", async () => {
  if (aborting) process.exit(130);
  aborting = true;
  const seq = await audit.attempt({ kind: "readPage" }, { gated: false });
  await audit.outcome(seq, { ok: false, error: "aborted by user (SIGINT)" });
  console.log("\n⏹  aborted — releasing browser, Chrome stays up");
  await session.close();
  process.exit(130);
});
```

Abort is logged *before* the browser is released, for the same reason attempts
are logged before execution: the record has to survive the thing it describes.

- [ ] **Step 3: Verify the loop end-to-end**

Run:
```bash
npm run spine -- --launch     # if Chrome isn't already up
npm run spine
```

Then, in the REPL, against a real job application form you have open:
```
read
fill g1-r0 Andes
read
submit g2-r14
```

Expected: `read` prints a ref'd tree. `fill` succeeds. The second `read` bumps to generation 2. `submit` prints the `⏸ GATED` prompt and does nothing unless you type `y`.

- [ ] **Step 4: Verify stale rejection on a real page**

In the REPL: `read`, note a ref like `g1-r5`, then `read` again (now generation 2), then `click g1-r5`.
Expected: `✗ Stale ref g1-r5: element no longer on the page. Re-observe and retry.` — and nothing clicked.

- [ ] **Step 5: Verify the audit log**

Run: `cat runs/spine-*.jsonl | tail -5`
Expected: JSONL pairs. The denied submit shows `"gated":true` with `"error":"approval denied"` and **no** successful outcome.

- [ ] **Step 6: Verify abort**

Run `npm run spine`, then press Ctrl-C.
Expected: `⏹ aborted` prints, the process exits, **Chrome stays open**, and the
last line of `runs/spine-*.jsonl` records `aborted by user (SIGINT)`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/spine.ts
git commit -m "feat(cli): spine REPL harness with abort semantics"
```

---

### Task 11: Answer the tree-quality question

**Files:**
- Create: `scripts/capture-fixture.ts`
- Create: `tests/fixtures/README.md`
- Create: `docs/superpowers/notes/2026-08-21-tree-quality-findings.md`

**This task is the reason Plan 1 exists.** Everything above is scaffolding for this measurement.

- [ ] **Step 1: Write the fixture capture script**

Create `scripts/capture-fixture.ts`:

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "../src/hands/browser/connect.js";
import { readPage, renderSnapshot } from "../src/hands/browser/snapshot.js";
import { capturePage } from "../src/hands/browser/capture.js";

const name = process.argv[2];
if (!name) {
  console.error("usage: npm run capture-fixture <name>   # e.g. greenhouse-acme");
  process.exit(1);
}

const dir = join(process.cwd(), "tests", "fixtures", name);
await mkdir(dir, { recursive: true });

const s = await connect();
const html = await s.page.content();
const snap = await readPage(s.page);
const shot = await capturePage(s.page);

await writeFile(join(dir, "page.html"), html, "utf8");
await writeFile(join(dir, "snapshot.txt"), renderSnapshot(snap), "utf8");
await writeFile(join(dir, "page.png"), Buffer.from(shot.base64, "base64"));

console.log(`${name}: ${snap.nodes.length} elements, ${snap.nodes.filter((n) => !n.name).length} unnamed`);
await s.close();
```

- [ ] **Step 2: Create the fixtures README**

Create `tests/fixtures/README.md`:

```markdown
# Page fixtures

Real ATS pages captured with `npm run capture-fixture <name>`. Each directory holds:

- `page.html` — full DOM at capture time
- `snapshot.txt` — what `readPage()` produced
- `page.png` — what `capturePage()` produced

These make the tree reader testable offline, with no network and no risk of
burning a real application (spec §11).

**Before committing a fixture, scrub it.** A captured application form may
contain your name, email, phone, and address. Redact them in `page.html` and
`snapshot.txt`, or keep the fixture local by adding it to `.gitignore`.
```

- [ ] **Step 3: Capture three real ATS pages**

Open a real application form for each of Greenhouse, Lever, and Workday in the dedicated Chrome profile, then for each:

Run: `npm run capture-fixture greenhouse-<company>` (then `lever-<company>`, `workday-<company>`)
Expected: prints element count and unnamed count for each.

- [ ] **Step 4: Assess and write up findings**

For each fixture, open `snapshot.txt` beside `page.png` and answer:

1. **Coverage** — is every field a human must fill present in the snapshot?
2. **Naming** — can you tell what each field wants from `name` alone? Count the unnamed.
3. **Actionability** — could you fill this whole form using only these refs?
4. **Custom widgets** — do dropdowns, date pickers, and file uploads appear as something usable, or as anonymous `button ""` entries?

Create `docs/superpowers/notes/2026-08-21-tree-quality-findings.md` recording, per ATS: element count, unnamed count, the answers above, and a verdict of **sufficient / needs capturePage / insufficient**.

- [ ] **Step 5: Decide**

- **All three sufficient** → §8.2 holds. Proceed to Plan 2.
- **Mostly sufficient, gaps on custom widgets** → expected. `capturePage()` covers it. Proceed to Plan 2, noting which widget types need vision.
- **Any ATS insufficient** (most fields unnamed or absent) → **stop.** Do not start Plan 2. Options in order of preference: (a) improve `nameOf` using `aria-labelledby` and enclosing-`<label>` traversal; (b) switch `stampAndCollect` to CDP `Accessibility.getFullAXTree`, which computes real accessible names at the cost of a heavier snapshot; (c) revisit §8.2 with the author.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-fixture.ts tests/fixtures/README.md docs/superpowers/notes/
git commit -m "feat(tests): ATS fixture capture + tree-quality findings"
```

- [ ] **Step 7: Push**

```bash
git push origin main
```

---

## Done when

- `npm test` passes (32 tests).
- `npm run spine` drives a real ATS form: `read` → `fill` → `read` → `submit` prompts the gate.
- A stale ref from an earlier generation is rejected without executing.
- `runs/*.jsonl` shows attempt/outcome pairs, including a denied submit and a Ctrl-C abort.
- `docs/superpowers/notes/2026-08-21-tree-quality-findings.md` records a verdict per ATS.

**Not in this plan:** models of any kind, the orchestrator loop, resume handling, Electron. Plans 2–4.
