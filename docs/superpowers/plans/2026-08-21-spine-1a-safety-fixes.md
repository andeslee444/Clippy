# Clippy Plan 1a — Spine Safety Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four confirmed safety defects and three correctness defects found reviewing Plan 1, so the orchestrator can be built on a spine that actually delivers its stated guarantees.

**Architecture:** Four changes, in dependency order. The `Action` type splits into `Effect` and `Observation` (nothing else can be typed correctly until it does). The page-side snapshot function moves out of the bundled module into a plain untransformed `.js` file loaded as text — killing a whole bug class rather than its latest instance — and gains credential redaction. The gate stops trusting the model's declared kind and keys off the resolved element. Every model-supplied string gets validated at the `hands/` boundary with the zod that is already installed.

**Tech Stack:** Unchanged — TypeScript 5, Node 20+, `playwright-core`, `vitest`, `tsx`, `zod`, `linkedom` (dev).

**Spec:** `docs/superpowers/specs/2026-08-20-clippy-v1-design.md` §7.1, §7.3, §7.5, §8.2 (all four rewritten in commit `0829689` to describe the corrected design).

**Predecessor:** `docs/superpowers/plans/2026-08-21-spine-browser-and-trust.md`. Tasks 1–8 of that plan are complete; 9–11 are on hold until this plan lands.

---

## The defects being fixed

Each was reproduced before this plan was written — none is speculative.

| ID | Defect | Evidence |
|---|---|---|
| **C1** | `readPage()` throws `ReferenceError: __name is not defined` on every call under `tsx`. `keepNames` wraps inner functions in a module-scope helper; vitest doesn't set that flag, so tests are green and production is broken | `npx tsx` → `THROWS IN PAGE CONTEXT → __name is not defined` |
| **C2** | Gate keys off the model-declared kind. `{kind:"click", ref:<Submit>}` submits ungated with `"gated":false` in the audit log | `click`/`submit` are byte-identical in `act.ts:30-32` |
| **C3** | `connect()` attaches to anything on port 9222 with no profile check — could be the user's primary Chrome | No verification exists |
| **C4** | `readPage()` harvests `type=password` values into the tree and into `runs/*.jsonl` | `{"name":"Password","value":"hunter2"}` |
| **I1/I2** | `capturePage` passes `clip` without `fullPage`, returning a viewport shot labelled as an 8000px page capture; no `scale`, so Retina doubles the pixels | Playwright trims clip to viewport unless `fullPage` |
| **I5** | Refs interpolate into a CSS selector unvalidated; upload paths and navigate URLs unrestricted | `g1-r0"], button[type="submit` → valid selector matching Submit |
| **I10** | Observations can't flow through the executor, so nothing observed is audited | `run()` returns `Promise<void>` |

---

## File Structure

| File | Change |
|---|---|
| `src/hands/types.ts` | **Modify** — split `Action` into `Effect` + `Observation`; `EFFECT_META` replaces `TOOL_META`; `upload` becomes outward-facing |
| `src/hands/schema.ts` | **Create** — zod validation for every model-supplied string |
| `src/hands/browser/page-script.js` | **Create** — plain, unbundled, loaded as text. The only code that runs inside the page |
| `src/hands/browser/snapshot.ts` | **Modify** — load the page script as text; `stampAndCollect` removed from this file |
| `src/hands/browser/act.ts` | **Modify** — `resolve()` returns element metadata; refuse click-on-submit; validate input |
| `src/hands/browser/capture.ts` | **Modify** — `fullPage` + clip, `scale: "css"` |
| `src/hands/browser/connect.ts` | **Modify** — non-default port, profile verification, tab reporting |
| `src/trust/policy.ts` | **Modify** — signature takes resolved element properties |

---

### Task A1: Split `Effect` from `Observation`

**Files:**
- Modify: `src/hands/types.ts`
- Modify: `src/hands/types.test.ts`
- Create: `src/hands/schema.ts`
- Test: `src/hands/schema.test.ts`

Do this first — every other task depends on these types.

- [ ] **Step 1: Replace `src/hands/types.ts` entirely**

```ts
/** A generation-scoped element reference, e.g. "g3-r12". Only valid within its generation. */
export type Ref = string;

/** Changes the world. Returns nothing. Can be gated. */
export type Effect =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: Ref }
  | { kind: "fill"; ref: Ref; value: string }
  | { kind: "select"; ref: Ref; value: string }
  | { kind: "upload"; ref: Ref; path: string }
  | { kind: "submit"; ref: Ref };

/** Changes nothing. Returns data. Never gated — see §7.3. */
export type Observation =
  | { kind: "readPage" }
  | { kind: "capturePage" };

/** Union used only for audit-log typing, where both are recorded. */
export type Action = Effect | Observation;

export interface ToolMeta {
  /** Can the effect be undone without contacting anyone? */
  reversible: boolean;
  /** Does this send something to a third party under the user's name? */
  outwardFacing: boolean;
}

/**
 * Properties derived from the RESOLVED DOM element, not from the model (§7.1).
 *
 * The model chooses the action kind, so the kind alone cannot be trusted to
 * distinguish a harmless click from a submit. These come from the page.
 */
export interface ElementFacts {
  /** Activating this element submits a form. */
  submitCapable: boolean;
}

/**
 * Static per-effect safety metadata (spec §7.1).
 *
 * The floor, not the ceiling: element-derived facts can only ADD gating.
 * Observations are absent by construction — they cannot be gated because they
 * cannot be irreversible.
 *
 * `upload` is outward-facing: many ATS platforms XHR-upload the file the moment
 * it is attached, before any submit. It is not reversible in any useful sense.
 */
export const EFFECT_META: Record<Effect["kind"], ToolMeta> = {
  navigate: { reversible: true,  outwardFacing: false },
  click:    { reversible: true,  outwardFacing: false },
  fill:     { reversible: true,  outwardFacing: false },
  select:   { reversible: true,  outwardFacing: false },
  upload:   { reversible: false, outwardFacing: true  },
  submit:   { reversible: false, outwardFacing: true  },
};
```

- [ ] **Step 2: Replace `src/hands/types.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { EFFECT_META, type Effect, type Observation } from "./types.js";

describe("EFFECT_META", () => {
  it("declares metadata for every effect kind", () => {
    const kinds: Effect["kind"][] = ["navigate", "click", "fill", "select", "upload", "submit"];
    for (const k of kinds) expect(EFFECT_META[k], `missing meta for ${k}`).toBeDefined();
  });

  it("marks submit as outward-facing and irreversible", () => {
    expect(EFFECT_META.submit).toEqual({ reversible: false, outwardFacing: true });
  });

  it("marks upload as outward-facing — ATS platforms upload on attach", () => {
    expect(EFFECT_META.upload).toEqual({ reversible: false, outwardFacing: true });
  });

  it("marks ordinary form interaction as reversible and internal", () => {
    expect(EFFECT_META.fill).toEqual({ reversible: true, outwardFacing: false });
    expect(EFFECT_META.click).toEqual({ reversible: true, outwardFacing: false });
  });

  it("has no entry for observations — they cannot be gated", () => {
    const observationKinds: Observation["kind"][] = ["readPage", "capturePage"];
    for (const k of observationKinds) {
      expect(Object.keys(EFFECT_META)).not.toContain(k);
    }
  });
});
```

- [ ] **Step 3: Run and verify**

Run: `npx vitest run src/hands/types.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 4: Write the failing schema test**

Create `src/hands/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseEffect, RefSchema } from "./schema.js";

describe("RefSchema", () => {
  it("accepts a well-formed ref", () => {
    expect(RefSchema.safeParse("g3-r12").success).toBe(true);
  });

  it("rejects a ref carrying a selector injection", () => {
    // This exact string produces:  [data-clippy-ref="g1-r0"], button[type="submit"]
    // — a valid selector matching the Submit button.
    expect(RefSchema.safeParse(`g1-r0"], button[type="submit`).success).toBe(false);
  });

  it("rejects refs with quotes, brackets, spaces, or wildcards", () => {
    for (const bad of [`g1-r0"`, "g1-r0]", "g1 r0", "*", "g1-r0 ", "", "grr"]) {
      expect(RefSchema.safeParse(bad).success, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("parseEffect", () => {
  it("accepts a valid click", () => {
    expect(parseEffect({ kind: "click", ref: "g1-r3" })).toEqual({ kind: "click", ref: "g1-r3" });
  });

  it("rejects file:// navigation — local file exfiltration", () => {
    expect(() => parseEffect({ kind: "navigate", url: "file:///Users/a/.aws/credentials" })).toThrow();
  });

  it("rejects non-http schemes", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://settings"]) {
      expect(() => parseEffect({ kind: "navigate", url }), url).toThrow();
    }
  });

  it("accepts https navigation", () => {
    expect(parseEffect({ kind: "navigate", url: "https://boards.greenhouse.io/x" })).toBeTruthy();
  });

  it("rejects an upload outside the allowed directory", () => {
    expect(() => parseEffect({ kind: "upload", ref: "g1-r1", path: "/Users/a/.ssh/id_rsa" })).toThrow();
  });

  it("rejects an upload escaping the allowed directory via ..", () => {
    expect(() =>
      parseEffect({ kind: "upload", ref: "g1-r1", path: `${process.cwd()}/documents/../../.ssh/id_rsa` }),
    ).toThrow();
  });

  it("accepts an upload inside the allowed directory", () => {
    const ok = parseEffect({ kind: "upload", ref: "g1-r1", path: `${process.cwd()}/documents/cv.docx` });
    expect(ok.kind).toBe("upload");
  });

  it("rejects an unknown kind", () => {
    expect(() => parseEffect({ kind: "evaluate", script: "fetch('/x')" })).toThrow();
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run src/hands/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 6: Create `src/hands/schema.ts`**

```ts
import { z } from "zod";
import { resolve as resolvePath, sep } from "node:path";
import type { Effect } from "./types.js";

/**
 * Refs are interpolated into a CSS attribute selector, so they must be
 * structurally incapable of escaping the quoted value. Anchored, digits only.
 */
export const RefSchema = z.string().regex(/^g\d+-r\d+$/, "malformed ref");

/** Only http(s). file:// would let an ungated navigate + readPage exfiltrate local files. */
const UrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:$/.test(new URL(u).protocol), "only http(s) URLs are allowed");

/** Uploads are confined to one directory. Resolved first, so `..` cannot escape. */
export const UPLOAD_ROOT = resolvePath(process.cwd(), "documents");

const UploadPathSchema = z
  .string()
  .transform((p) => resolvePath(p))
  .refine((p) => p === UPLOAD_ROOT || p.startsWith(UPLOAD_ROOT + sep), {
    message: `uploads must live under ${UPLOAD_ROOT}`,
  });

const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: UrlSchema }),
  z.object({ kind: z.literal("click"), ref: RefSchema }),
  z.object({ kind: z.literal("fill"), ref: RefSchema, value: z.string().max(10_000) }),
  z.object({ kind: z.literal("select"), ref: RefSchema, value: z.string().max(1_000) }),
  z.object({ kind: z.literal("upload"), ref: RefSchema, path: UploadPathSchema }),
  z.object({ kind: z.literal("submit"), ref: RefSchema }),
]);

/**
 * Validate a model-supplied effect at the `hands/` boundary.
 *
 * Everything reaching here originates from a model that read attacker-controlled
 * page text. Nothing past this point may assume any field is well-formed.
 */
export function parseEffect(input: unknown): Effect {
  return EffectSchema.parse(input) as Effect;
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/hands/schema.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 8: Commit**

```bash
git add src/hands/types.ts src/hands/types.test.ts src/hands/schema.ts src/hands/schema.test.ts
git commit -m "feat(hands): split Effect from Observation; validate model input"
```

---

### Task A2: Page script out of the bundle, with redaction

**Files:**
- Create: `src/hands/browser/page-script.js`
- Modify: `src/hands/browser/snapshot.ts`
- Modify: `src/hands/browser/snapshot.test.ts`

Fixes **C1** (the `__name` bug) structurally and **C4** (password harvesting).

- [ ] **Step 1: Create `src/hands/browser/page-script.js`**

Plain JavaScript. **No bundler touches this file** — it is read as text at runtime and evaluated inside the page. That is the entire point: it physically cannot close over module scope, so the `SELECTOR`/`__name` bug class cannot recur.

```js
// @ts-check
/*
 * RUNS INSIDE THE PAGE. Loaded as TEXT by snapshot.ts and evaluated there.
 *
 * Do not import anything here. Do not reference anything outside this
 * expression. Do not let a bundler process this file — that is what broke the
 * two previous versions of this code (a module-scope `SELECTOR`, then `__name`
 * injected by esbuild's keepNames around inner functions).
 *
 * The file is exactly one parenthesised function expression, so
 * `new Function("return " + text)()` yields the function.
 */
(function stampAndCollect(doc, generation) {
  var SELECTOR =
    "input, textarea, select, button, a[href], [role=button], [contenteditable=true]";
  var SENSITIVE_NAME = /ssn|social|passport|tax|routing|account|cvv|cvc/i;
  var REDACTED = "•••";
  var MAX_NAME = 80;

  var stale = doc.querySelectorAll("[data-clippy-ref]");
  for (var s = 0; s < stale.length; s++) {
    stale[s].removeAttribute("data-clippy-ref");
    stale[s].removeAttribute("data-clippy-submit");
  }

  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "file";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") {
      return "button";
    }
    if (type === "password") return "password";
    return "textbox";
  }

  function labelFor(el) {
    var id = el.getAttribute("id");
    if (!id) return null;
    var labels = doc.querySelectorAll("label[for]");
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].getAttribute("for") === id) return labels[i];
    }
    return null;
  }

  /* Page text is attacker-controlled. Collapse whitespace on EVERY path so a
     crafted aria-label cannot forge a line break in the rendered tree, escape
     quotes so it cannot forge a field boundary, and cap the length. */
  function sanitize(raw) {
    if (!raw) return "";
    var flat = String(raw).replace(/\s+/g, " ").replace(/"/g, "'").trim();
    return flat.length > MAX_NAME ? flat.slice(0, MAX_NAME) + "…" : flat;
  }

  function nameOf(el) {
    var label = labelFor(el);
    if (label && label.textContent && label.textContent.trim()) return sanitize(label.textContent);
    if (el.getAttribute("aria-label")) return sanitize(el.getAttribute("aria-label"));
    if (el.getAttribute("placeholder")) return sanitize(el.getAttribute("placeholder"));
    return sanitize(el.textContent);
  }

  /* Spec §7.5: credentials must never leave the page, because the takeover
     protocol has the user type a real password into this very browser. */
  function isSecret(el) {
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    var auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.indexOf("cc-") === 0 || auto === "current-password" || auto === "new-password") {
      return true;
    }
    var ident = (el.getAttribute("name") || "") + " " + (el.getAttribute("id") || "");
    return SENSITIVE_NAME.test(ident);
  }

  /* Activating this submits a form — so a `click` on it must be refused (§7.1). */
  function isSubmitCapable(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && (type === "submit" || type === "image")) return true;
    if (tag === "button" && type !== "button" && type !== "reset") {
      return Boolean(el.closest("form")) || type === "submit";
    }
    return false;
  }

  function isDisabled(el) {
    try {
      return el.matches(":disabled");
    } catch (e) {
      return el.hasAttribute("disabled");
    }
  }

  function isRendered(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if ((el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
    if (el.hasAttribute("hidden")) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility();
    if (typeof el.getClientRects === "function") return el.getClientRects().length > 0;
    return true;
  }

  var out = [];
  var els = doc.querySelectorAll(SELECTOR);
  var i = 0;
  for (var n = 0; n < els.length; n++) {
    var el = els[n];
    if (!isRendered(el)) continue;

    var ref = "g" + generation + "-r" + i++;
    el.setAttribute("data-clippy-ref", ref);

    var submitCapable = isSubmitCapable(el);
    if (submitCapable) el.setAttribute("data-clippy-submit", "1");

    var secret = isSecret(el);
    var rawValue = el.value !== undefined && el.value !== null
      ? el.value
      : el.getAttribute("value");
    var value = secret ? (rawValue ? REDACTED : undefined) : (sanitize(rawValue) || undefined);

    out.push({
      ref: ref,
      role: roleOf(el),
      name: nameOf(el),
      value: value,
      submitCapable: submitCapable,
      disabled: isDisabled(el),
      redacted: secret || undefined,
    });
  }
  return out;
})
```

Note `isDisabled` **emits** the element with a flag rather than dropping it. The previous version omitted disabled controls entirely, so a model could not see that Submit exists but is disabled because a required field is empty — and would loop or go STUCK for the wrong reason.

- [ ] **Step 2: Replace `src/hands/browser/snapshot.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import type { Ref } from "../types.js";

export interface RefNode {
  ref: Ref;
  role: string;
  name: string;
  value?: string;
  submitCapable: boolean;
  disabled: boolean;
  redacted?: boolean;
}

export interface Snapshot {
  generation: number;
  url: string;
  title: string;
  nodes: RefNode[];
}

/**
 * The page-side function, as text. Read from an unbundled `.js` file rather than
 * serialised with `.toString()` — see spec §8.2. Serialising a bundled function
 * shipped two production failures (`SELECTOR`, then esbuild's injected `__name`),
 * both invisible to tests because the test bundler differs from the production one.
 */
export const PAGE_SCRIPT: string = readFileSync(
  fileURLToPath(new URL("./page-script.js", import.meta.url)),
  "utf8",
);

/**
 * Process-unique generation seed. A bare counter restarting at 0 would let a ref
 * recorded by one process resolve against a *different* element in the next,
 * since Chrome keeps the page and its stamped attributes across CLI restarts.
 */
let generation = Math.floor(Date.now() / 1000);

/** Take a fresh ref'd snapshot of the page, bumping the generation (spec §8.2). */
export async function readPage(page: Page): Promise<Snapshot> {
  const gen = ++generation;
  const nodes = (await page.evaluate(
    ({ src, g }: { src: string; g: number }) =>
      (new Function("return (" + src + ")")() as (d: Document, n: number) => unknown)(document, g),
    { src: PAGE_SCRIPT, g: gen },
  )) as RefNode[];
  return { generation: gen, url: page.url(), title: await page.title(), nodes };
}

/** Compact text rendering for a model prompt (spec §8.2 — ~2KB, not pixels). */
export function renderSnapshot(s: Snapshot): string {
  const lines = s.nodes.map((n) => {
    const flags = [n.disabled ? "disabled" : "", n.redacted ? "redacted" : ""]
      .filter(Boolean)
      .join(" ");
    return (
      `${n.ref} ${n.role} "${n.name}"` +
      (n.value ? ` = "${n.value}"` : "") +
      (flags ? ` [${flags}]` : "")
    );
  });
  return [`# ${s.title}`, `# ${s.url}`, ...lines].join("\n");
}
```

- [ ] **Step 3: Replace `src/hands/browser/snapshot.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { PAGE_SCRIPT, renderSnapshot } from "./snapshot.js";

/**
 * Build the page function the SAME way readPage() does — from the file text,
 * never from `.toString()` on a bundled function. This is the only construction
 * that exercises the production path.
 *
 * The parentheses are mandatory, not cosmetic. page-script.js opens with a
 * `// @ts-check` line comment, so `"return " + src` puts a line terminator
 * between `return` and the expression — ASI inserts a semicolon, the function
 * is discarded, and `new Function(...)()` yields `undefined`. Wrapping in
 * parens keeps the expression on the same line as `return`.
 */
function loadPageFn(): (doc: Document, generation: number) => any[] {
  return new Function("return (" + PAGE_SCRIPT + ")")();
}

function fakeDoc(html: string): Document {
  return parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
}

const collect = (html: string, gen = 1) => loadPageFn()(fakeDoc(html), gen);

describe("page-script", () => {
  it("is loadable as a standalone function — the production path", () => {
    expect(typeof loadPageFn()).toBe("function");
  });

  it("contains no bundler-injected helpers", () => {
    // If a bundler ever starts processing this file, these appear and the
    // function breaks inside the page. Cheap canary for the whole bug class.
    //
    // Matches CALL SITES, not bare identifiers: the file's own documentation
    // names `__name` while explaining the historical bug, and a broader regex
    // would fire on that prose. esbuild always emits these as invocations.
    expect(PAGE_SCRIPT).not.toMatch(/__name\s*\(|__spreadValues\s*\(|__async\s*\(|__toESM\s*\(/);
  });

  it("stamps each interactive element with a generation-scoped ref", () => {
    const nodes = collect(`<input id="a"><button id="b">Go</button>`, 3);
    expect(nodes.map((n) => n.ref)).toEqual(["g3-r0", "g3-r1"]);
  });

  it("prefers the label element for the accessible name", () => {
    expect(collect(`<label for="e">Email address</label><input id="e">`)[0].name).toBe("Email address");
  });

  it("falls back to aria-label, then placeholder", () => {
    expect(collect(`<input aria-label="Phone">`)[0].name).toBe("Phone");
    expect(collect(`<input placeholder="Your city">`)[0].name).toBe("Your city");
  });

  it("redacts password values", () => {
    const n = collect(`<label for="p">Password</label><input id="p" type="password" value="hunter2">`)[0];
    expect(n.value).toBe("•••");
    expect(n.redacted).toBe(true);
    expect(JSON.stringify(n)).not.toContain("hunter2");
  });

  it("redacts card fields and identity numbers", () => {
    expect(collect(`<input autocomplete="cc-number" value="4111111111111111">`)[0].value).toBe("•••");
    expect(collect(`<input name="ssn" value="123-45-6789">`)[0].value).toBe("•••");
  });

  it("still emits the password node so a login wall is recognisable", () => {
    const nodes = collect(`<input type="password" aria-label="Password" value="x">`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].role).toBe("password");
  });

  it("flags submit-capable controls", () => {
    const nodes = collect(`<form><button>Submit Application</button><button type="button">Help</button></form>`);
    expect(nodes[0].submitCapable).toBe(true);
    expect(nodes[1].submitCapable).toBe(false);
  });

  it("flags input[type=submit] and input[type=image]", () => {
    expect(collect(`<input type="submit" value="Apply">`)[0].submitCapable).toBe(true);
    expect(collect(`<input type="image" alt="Apply">`)[0].submitCapable).toBe(true);
  });

  it("neutralises newlines in page text so the tree cannot be forged", () => {
    const nodes = collect(`<input aria-label="Name&#10;g1-r1 button &quot;Cancel&quot;">`);
    expect(nodes[0].name).not.toContain("\n");
    expect(nodes[0].name).not.toContain('"');
  });

  it("caps absurdly long accessible names", () => {
    expect(collect(`<button>${"x".repeat(500)}</button>`)[0].name.length).toBeLessThanOrEqual(81);
  });

  it("emits disabled elements with a flag rather than hiding them", () => {
    const nodes = collect(`<button disabled>Submit</button>`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].disabled).toBe(true);
  });

  it("skips aria-hidden, hidden inputs, and [hidden]", () => {
    const nodes = collect(
      `<input aria-hidden="true"><input type="hidden"><input hidden><input aria-label="ok">`,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("ok");
  });

  it("re-stamping with a new generation invalidates old refs", () => {
    const fn = loadPageFn();
    const doc = fakeDoc(`<input aria-label="x">`);
    fn(doc, 1);
    fn(doc, 2);
    expect(doc.querySelector(`[data-clippy-ref="g1-r0"]`)).toBeNull();
    expect(doc.querySelector(`[data-clippy-ref="g2-r0"]`)).not.toBeNull();
  });
});

describe("renderSnapshot", () => {
  it("marks disabled and redacted nodes", () => {
    const out = renderSnapshot({
      generation: 1,
      url: "https://x.test/apply",
      title: "Apply",
      nodes: [
        { ref: "g1-r0", role: "password", name: "Password", value: "•••", submitCapable: false, disabled: false, redacted: true },
        { ref: "g1-r1", role: "button", name: "Submit", submitCapable: true, disabled: true },
      ],
    });
    expect(out).toContain("[redacted]");
    expect(out).toContain("[disabled]");
  });
});
```

- [ ] **Step 4: Run under BOTH runtimes**

Run: `npx vitest run src/hands/browser/snapshot.test.ts`
Expected: PASS — 16 tests.

Then the production runtime, which is where the old code failed:

Write `_check.mjs` at the repo root (`npx tsx -e` cannot resolve relative imports
on Node 24 — use a driver file, and delete it afterwards):

```js
import { PAGE_SCRIPT } from "./src/hands/browser/snapshot.js";
import { parseHTML } from "linkedom";
const fn = new Function("return (" + PAGE_SCRIPT + ")")();
const d = parseHTML(`<html><body><input aria-label="x"><button>Go</button></body></html>`).document;
console.log("typeof fn:", typeof fn);
console.log("tsx OK:", JSON.stringify(fn(d, 1)));
```

Run: `npx tsx _check.mjs && rm _check.mjs`
Expected: `typeof fn: function`, then two nodes. **This is the exact invocation that
previously threw `__name is not defined`.** If `typeof fn` is `undefined` or it throws,
stop — the bug is not fixed.

- [ ] **Step 5: Commit**

```bash
git add src/hands/browser/page-script.js src/hands/browser/snapshot.ts src/hands/browser/snapshot.test.ts
git commit -m "fix(hands): page script out of the bundle; redact credentials"
```

---

### Task A3: Element-derived gating

**Files:**
- Modify: `src/trust/policy.ts`, `src/trust/policy.test.ts`
- Modify: `src/hands/browser/act.ts`, `src/hands/browser/act.test.ts`

Fixes **C2**. The gate stops trusting the model's declared kind.

- [ ] **Step 1: Replace `src/trust/policy.ts`**

```ts
import { EFFECT_META, type Effect, type ElementFacts } from "../hands/types.js";

/**
 * The safety boundary (spec §7.1).
 *
 * Returns true if `effect` must not execute until a human has approved it.
 *
 * Pure. Never consults a model, the page, or run state. `facts` are derived from
 * the RESOLVED DOM element by the page script — not supplied by the model — and
 * can only ever ADD gating on top of the static table.
 *
 * TODO(author): implement. See Plan 1a, Task A3 for the trade-offs.
 */
export function isGated(effect: Effect, facts?: ElementFacts): boolean {
  void EFFECT_META;
  void effect;
  void facts;
  throw new Error("isGated not implemented — see docs/superpowers/plans, Plan 1a Task A3");
}
```

- [ ] **Step 2: Replace `src/trust/policy.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { isGated } from "./policy.js";
import type { Effect } from "../hands/types.js";

const e = (x: Effect) => x;

describe("isGated", () => {
  it("gates submit", () => {
    expect(isGated(e({ kind: "submit", ref: "g1-r1" }))).toBe(true);
  });

  it("gates upload — ATS platforms upload on attach", () => {
    expect(isGated(e({ kind: "upload", ref: "g1-r1", path: "/x/cv.docx" }))).toBe(true);
  });

  it("does not gate ordinary form interaction", () => {
    expect(isGated(e({ kind: "fill", ref: "g1-r2", value: "Andes" }))).toBe(false);
    expect(isGated(e({ kind: "select", ref: "g1-r4", value: "Yes" }))).toBe(false);
  });

  it("does not gate navigation", () => {
    expect(isGated(e({ kind: "navigate", url: "https://boards.greenhouse.io/x" }))).toBe(false);
  });

  it("does not gate a click on an ordinary control", () => {
    expect(isGated(e({ kind: "click", ref: "g1-r3" }), { submitCapable: false })).toBe(false);
  });

  it("GATES a click on a submit-capable element — the kind is model-supplied", () => {
    expect(isGated(e({ kind: "click", ref: "g1-r3" }), { submitCapable: true })).toBe(true);
  });

  it("is pure", () => {
    const a = e({ kind: "submit", ref: "g1-r1" });
    expect(isGated(a)).toBe(isGated(a));
  });
});
```

- [ ] **Step 3: Run to verify RED**

Run: `npx vitest run src/trust/policy.test.ts`
Expected: FAIL — 7 tests, all `isGated not implemented`.

- [ ] **Step 4: 🧑 AUTHOR — implement `isGated`**

> **AUTHOR CONTRIBUTION.** An agent executing this plan must stop here and hand back.

Reference shape (the predicate itself is deliberately not prescribed):

```ts
export function isGated(effect: Effect, facts?: ElementFacts): boolean {
  const meta = EFFECT_META[effect.kind];
  return /* combine meta.outwardFacing / meta.reversible with facts?.submitCapable */;
}
```

**What changed since Plan 1 made this your call:** the interesting decision moved. `EFFECT_META` now carries two genuinely different rows (`upload` and `submit` are both irreversible and outward-facing; the rest are neither), and `facts.submitCapable` is a third input the model cannot forge. The question is how those three combine — in particular whether a `click` on a submit-capable element should *gate* (approve it and it proceeds) or be *refused outright* (Task A3 Step 6 refuses it at the `hands/` layer regardless, so gating here is defence in depth).

- [ ] **Step 5: Run to verify GREEN**

Run: `npx vitest run src/trust/policy.test.ts`
Expected: PASS — 7 tests. If your policy gates more than the tests expect, update the tests to match and say why in the commit message.

- [ ] **Step 6: Replace `src/hands/browser/act.ts`**

```ts
import type { Locator, Page } from "playwright-core";
import { parseEffect } from "../schema.js";
import type { Effect, ElementFacts, Ref } from "../types.js";

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

/**
 * A `click` was aimed at a control that submits a form (spec §7.1).
 *
 * Refused rather than silently upgraded to `submit`: coercion would hide the
 * discrepancy, and a model that mislabels a submit is a signal worth surfacing.
 */
export class SubmitCapableError extends Error {
  constructor(public readonly ref: Ref) {
    super(`Refusing click on ${ref}: it submits a form. Use kind "submit", which gates.`);
    this.name = "SubmitCapableError";
  }
}

export interface Resolved {
  locator: Locator;
  facts: ElementFacts;
}

/**
 * Resolve a ref to an element plus the facts derived from the DOM.
 *
 * `facts` comes from attributes the page script stamped — not from the model.
 */
export async function resolve(page: Page, ref: Ref): Promise<Resolved> {
  const locator = page.locator(`[data-clippy-ref="${ref}"]`);
  if ((await locator.count()) === 0) throw new StaleRefError(ref);
  const submitCapable = (await locator.getAttribute("data-clippy-submit")) === "1";
  return { locator, facts: { submitCapable } };
}

/**
 * Execute one effect. Validates input, then throws BEFORE any side effect if the
 * ref is stale or the element disagrees with the declared kind.
 */
export async function performEffect(page: Page, raw: Effect): Promise<void> {
  const effect = parseEffect(raw);

  if (effect.kind === "navigate") {
    await page.goto(effect.url, { waitUntil: "domcontentloaded" });
    await settle(page);
    return;
  }

  const { locator, facts } = await resolve(page, effect.ref);

  if (effect.kind === "click" && facts.submitCapable) throw new SubmitCapableError(effect.ref);

  switch (effect.kind) {
    case "click":
    case "submit":
      await locator.click();
      break;
    case "fill":
      await locator.fill(effect.value);
      break;
    case "select":
      await locator.selectOption(effect.value);
      break;
    case "upload":
      await locator.setInputFiles(effect.path);
      break;
  }
  await settle(page);
}

export interface SettleResult {
  settled: boolean;
  reason?: string;
}

/**
 * Wait for the page to stop moving before the next snapshot (spec §8.4).
 *
 * `networkidle` is bounded: on an ATS with analytics beacons or a websocket it
 * never fires, and an unbounded wait would burn the full 30s default on every
 * action while silently pretending it settled.
 */
export async function settle(page: Page): Promise<SettleResult> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    return { settled: false, reason: "domcontentloaded timed out or context was destroyed" };
  }
  try {
    await page.waitForLoadState("networkidle", { timeout: 2_000 });
    return { settled: true };
  } catch {
    return { settled: false, reason: "network still active after 2s" };
  }
}
```

- [ ] **Step 7: Replace `src/hands/browser/act.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { StaleRefError, SubmitCapableError, performEffect } from "./act.js";

function fakePage(opts: { found?: boolean; submitCapable?: boolean } = {}) {
  const found = opts.found ?? true;
  const calls: string[] = [];
  const locator = {
    count: async () => (found ? 1 : 0),
    getAttribute: async (n: string) =>
      n === "data-clippy-submit" && opts.submitCapable ? "1" : null,
    click: vi.fn(async () => { calls.push("click"); }),
    fill: vi.fn(async (v: string) => { calls.push(`fill:${v}`); }),
    selectOption: vi.fn(async (v: string) => { calls.push(`select:${v}`); }),
    setInputFiles: vi.fn(async (p: string) => { calls.push(`upload:${p}`); }),
  };
  const locatorFn = vi.fn(() => locator);
  return {
    page: {
      locator: locatorFn,
      goto: vi.fn(async (u: string) => { calls.push(`goto:${u}`); }),
      waitForLoadState: vi.fn(async () => {}),
    } as any,
    locator,
    locatorFn,
    calls,
  };
}

describe("performEffect", () => {
  it("addresses the element by its exact ref", async () => {
    const { page, locatorFn } = fakePage();
    await performEffect(page, { kind: "click", ref: "g1-r3" });
    expect(locatorFn).toHaveBeenCalledWith(`[data-clippy-ref="g1-r3"]`);
  });

  it("clicks an ordinary control", async () => {
    const { page, calls } = fakePage();
    await performEffect(page, { kind: "click", ref: "g1-r3" });
    expect(calls).toContain("click");
  });

  it("fills, selects, and uploads", async () => {
    const f = fakePage();
    await performEffect(f.page, { kind: "fill", ref: "g1-r2", value: "Andes" });
    expect(f.calls).toContain("fill:Andes");

    const s = fakePage();
    await performEffect(s.page, { kind: "select", ref: "g1-r4", value: "Yes" });
    expect(s.calls).toContain("select:Yes");

    const u = fakePage();
    const path = `${process.cwd()}/documents/cv.docx`;
    await performEffect(u.page, { kind: "upload", ref: "g1-r5", path });
    expect(u.calls).toContain(`upload:${path}`);
  });

  it("throws StaleRefError when the ref is not on the page", async () => {
    const { page } = fakePage({ found: false });
    await expect(performEffect(page, { kind: "click", ref: "g1-r3" }))
      .rejects.toBeInstanceOf(StaleRefError);
  });

  it("executes NOTHING when the ref is stale", async () => {
    const { page, locator } = fakePage({ found: false });
    await performEffect(page, { kind: "click", ref: "g1-r3" }).catch(() => {});
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("REFUSES a click on a submit-capable element", async () => {
    const { page } = fakePage({ submitCapable: true });
    await expect(performEffect(page, { kind: "click", ref: "g1-r9" }))
      .rejects.toBeInstanceOf(SubmitCapableError);
  });

  it("executes NOTHING when refusing a submit-capable click", async () => {
    const { page, locator } = fakePage({ submitCapable: true });
    await performEffect(page, { kind: "click", ref: "g1-r9" }).catch(() => {});
    expect(locator.click).not.toHaveBeenCalled();
  });

  it("allows submit on a submit-capable element", async () => {
    const { page, calls } = fakePage({ submitCapable: true });
    await performEffect(page, { kind: "submit", ref: "g1-r9" });
    expect(calls).toContain("click");
  });

  it("rejects an injected ref before touching the page", async () => {
    const { page, locatorFn } = fakePage();
    await expect(
      performEffect(page, { kind: "click", ref: `g1-r0"], button[type="submit` } as any),
    ).rejects.toThrow();
    expect(locatorFn).not.toHaveBeenCalled();
  });

  it("rejects file:// navigation before touching the page", async () => {
    const { page } = fakePage();
    await expect(
      performEffect(page, { kind: "navigate", url: "file:///etc/passwd" } as any),
    ).rejects.toThrow();
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("navigates to https without needing a ref", async () => {
    const { page, calls } = fakePage({ found: false });
    await performEffect(page, { kind: "navigate", url: "https://example.com/" });
    expect(calls).toContain("goto:https://example.com/");
  });
});
```

- [ ] **Step 8: Run**

Run: `npx vitest run src/hands/browser/act.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 9: Commit**

```bash
git add src/trust/policy.ts src/trust/policy.test.ts src/hands/browser/act.ts src/hands/browser/act.test.ts
git commit -m "fix(trust): gate on the resolved element, not the declared kind"
```

---

### Task A4: Capture and connection hardening

**Files:**
- Modify: `src/hands/browser/capture.ts`
- Modify: `src/hands/browser/connect.ts`
- Modify: `src/trust/audit.ts`

Fixes **I1**, **I2**, **C3**, and the unhandled-rejection issue in the audit log.

- [ ] **Step 1: Replace `src/hands/browser/capture.ts`**

```ts
import type { Page } from "playwright-core";

/** Ceiling on the captured region, CSS pixels. Also the model's image limit. */
const MAX_HEIGHT = 8000;
const MAX_WIDTH = 2000;

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

  const truncated = dims.height > MAX_HEIGHT || dims.width > MAX_WIDTH;
  const width = Math.min(dims.width, MAX_WIDTH);
  const height = Math.min(dims.height, MAX_HEIGHT);

  const buf = await page.screenshot({
    type: "png",
    // `fullPage` is required even WITH `clip`. Without it Playwright trims the
    // clip to the viewport and leaves captureBeyondViewport off — returning a
    // viewport screenshot mislabelled as a full-page one.
    fullPage: true,
    clip: { x: 0, y: 0, width, height },
    // Default is "device": on a Retina display an 8000 CSS-px clip yields a
    // 16000 px PNG, over the model's image limit, with returned dimensions that
    // do not match the encoded image.
    scale: "css",
  });

  return { base64: buf.toString("base64"), width, height, truncated };
}
```

- [ ] **Step 2: Replace `src/hands/browser/connect.ts`**

```ts
import { chromium, type Browser, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CLIPPY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/**
 * Deliberately NOT 9222. That port is the universal CDP default, so anything
 * else on the machine could be holding it — with the user's PRIMARY profile.
 * Attaching to that would put their email and bank one navigation away.
 */
const PORT = Number(process.env.CLIPPY_CDP_PORT ?? 9333);
/** Dedicated profile — NOT the user's primary Chrome data dir (spec §3.1). */
export const PROFILE_DIR = join(homedir(), ".clippy", "chrome-profile");

/** Launch the dedicated profile with the debugging port open. Detached: survives the CLI. */
export function launchChrome(): void {
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", (err) => {
    console.error(`Could not launch Chrome at ${CHROME}: ${err.message}`);
    console.error("Set CLIPPY_CHROME to the correct path.");
  });
  child.unref();
}

export interface Session {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

export class WrongProfileError extends Error {
  constructor(actual: string) {
    super(
      `Chrome on port ${PORT} is running profile "${actual}", not ${PROFILE_DIR}. ` +
        `Refusing to attach — this could be your primary browser. Close it and run with --launch.`,
    );
    this.name = "WrongProfileError";
  }
}

/** Attach to the dedicated profile, verifying it IS the dedicated profile. */
export async function connect(): Promise<Session> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  } catch (cause) {
    throw new Error(`No Chrome on port ${PORT}. Start it with: npm run spine -- --launch`, {
      cause,
    });
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Verify the profile before handing back anything that can act on it.
  const cdp = await context.newCDPSession(page);
  const { commandLine } = (await cdp.send("Browser.getBrowserCommandLine")) as {
    commandLine: string[];
  };
  const dirArg = commandLine.find((a) => a.startsWith("--user-data-dir="));
  const actual = dirArg?.slice("--user-data-dir=".length) ?? "(unknown)";
  if (actual !== PROFILE_DIR) {
    await browser.close();
    throw new WrongProfileError(actual);
  }

  console.error(`attached: ${PROFILE_DIR} — ${page.url()}`);

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

- [ ] **Step 3: Patch the audit log's startup rejection**

In `src/trust/audit.ts`, replace the constructor and add a failure field, so an unwritable path surfaces as a clear error from `attempt()` rather than an unhandled rejection that kills the process with a bare `ENOENT`:

```ts
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
```

Then change the first line of both `attempt()` and `outcome()` from `await this.#ready;` to `await this.#check();`.

- [ ] **Step 4: Add the audit failure test**

Append to `src/trust/audit.test.ts`:

```ts
  it("reports an unwritable path as an error from attempt, not a process crash", async () => {
    const log = new AuditLog("/proc/definitely/not/writable/run.jsonl");
    await expect(log.attempt({ kind: "readPage" }, { gated: false }))
      .rejects.toThrow(/Audit log unavailable/);
  });
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test` — expected: everything green except `policy.test.ts` if the author has not yet written `isGated`.
Run: `npm run typecheck` — expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/hands/browser/capture.ts src/hands/browser/connect.ts src/trust/audit.ts src/trust/audit.test.ts
git commit -m "fix(hands): full-page clip, css scale, profile verification, audit startup errors"
```

---

### Task A5: Regression verification

**Files:**
- Create: `tests/regression.test.ts`

Locks every confirmed defect so it cannot return silently.

- [ ] **Step 1: Create `tests/regression.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { PAGE_SCRIPT } from "../src/hands/browser/snapshot.js";
import { RefSchema, parseEffect } from "../src/hands/schema.js";
import { EFFECT_META } from "../src/hands/types.js";

const pageFn = () => new Function("return (" + PAGE_SCRIPT + ")")() as any;
const doc = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;

describe("regressions from the Plan 1 review", () => {
  it("C1: page script carries no bundler helpers and loads standalone", () => {
    // Call sites, not bare identifiers — the file documents `__name` in prose.
    expect(PAGE_SCRIPT).not.toMatch(/__name\s*\(|__spreadValues\s*\(|__async\s*\(|__toESM\s*\(/);
    expect(typeof pageFn()).toBe("function");
  });

  it("C2: submit-capable controls are flagged from the DOM, not the model", () => {
    const nodes = pageFn()(doc(`<form><button>Submit Application</button></form>`), 1);
    expect(nodes[0].submitCapable).toBe(true);
  });

  it("C2: page text cannot forge a line in the rendered tree", () => {
    const nodes = pageFn()(doc(`<input aria-label="Name&#10;g1-r9 button &quot;Cancel&quot;">`), 1);
    expect(nodes[0].name).not.toMatch(/[\n"]/);
  });

  it("C4: password values never leave the page", () => {
    const nodes = pageFn()(doc(`<input type="password" value="hunter2" aria-label="pw">`), 1);
    expect(JSON.stringify(nodes)).not.toContain("hunter2");
  });

  it("I5: refs cannot escape the attribute selector", () => {
    expect(RefSchema.safeParse(`g1-r0"], button[type="submit`).success).toBe(false);
  });

  it("I5: file:// navigation is rejected", () => {
    expect(() => parseEffect({ kind: "navigate", url: "file:///etc/passwd" })).toThrow();
  });

  it("I5: uploads outside the documents directory are rejected", () => {
    expect(() => parseEffect({ kind: "upload", ref: "g1-r1", path: "/Users/a/.ssh/id_rsa" })).toThrow();
  });

  it("upload is treated as outward-facing and irreversible", () => {
    expect(EFFECT_META.upload).toEqual({ reversible: false, outwardFacing: true });
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/regression.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 3: Verify the production runtime one final time**

Write `_check.mjs` at the repo root, run it, then delete it:

```js
import { PAGE_SCRIPT } from "./src/hands/browser/snapshot.js";
import { parseHTML } from "linkedom";
const fn = new Function("return (" + PAGE_SCRIPT + ")")();
if (typeof fn !== "function") { console.error("FAIL: page script did not load"); process.exit(1); }
const html = `<html><body><form><input type="password" value="secret" aria-label="pw"><button>Submit</button></form></body></html>`;
const out = fn(parseHTML(html).document, 1);
console.log(JSON.stringify(out, null, 1));
if (JSON.stringify(out).includes("secret")) { console.error("FAIL: password leaked"); process.exit(1); }
if (!out[1].submitCapable) { console.error("FAIL: submit not detected"); process.exit(1); }
console.log("tsx runtime: OK");
```

Run: `npx tsx _check.mjs && rm _check.mjs`
Expected: prints the nodes, then `tsx runtime: OK`.

- [ ] **Step 4: Commit and push**

```bash
git add tests/regression.test.ts
git commit -m "test: lock the Plan 1 review regressions"
git push origin plan-1-spine
```

---

## Done when

- `npm test` green (`policy.test.ts` pending the author's `isGated`).
- `npm run typecheck` exit 0.
- The `tsx` invocation in A5 Step 3 prints `tsx runtime: OK` — this is the check that would have caught C1.
- No password, card, or identity value appears anywhere in a snapshot.
- A `click` on a submit-capable element is refused, and executes nothing.

**Then:** resume Plan 1 Tasks 9–11, with Task 9 rewritten against `Effect`/`Observation`.
