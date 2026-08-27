import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * A lint rule wearing a test's clothes, and deliberately so — see spec §11.1.
 *
 * tsx/esbuild compile with keepNames, which rewrites `const seen = (e) => …`
 * into `__name((e) => …, "seen")`. `__name` is a bundler helper that does not
 * exist in the browser, so any callback passed to page.evaluate containing a
 * NAMED function throws ReferenceError at runtime while compiling and
 * unit-testing perfectly cleanly.
 *
 * No behavioural test can catch this: the fake Page used by these tests returns
 * a canned value and never executes the callback at all. This has shipped
 * twice — once costing the page script, once silently turning every submit into
 * a failure — so the invariant is asserted against the source instead.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Strip comments so prose ABOUT this rule does not trip it. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Bodies of every `.evaluate(...)` call, by bracket matching.
 *
 * Quotes and template literals are skipped so a `)` inside a selector string —
 * `'[role="option"]:not(.disabled)'` — does not close the call early.
 */
function evaluateCallbacks(source: string): string[] {
  const found: string[] = [];
  const call = /\.evaluate(?:All|Handle)?\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = call.exec(source)) !== null) {
    const start = call.lastIndex;
    let i = start;
    let depth = 1;

    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "\\") i++;
          i++;
        }
      } else if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    found.push(source.slice(start, i - 1));
  }
  return found;
}

/** Ways to give a function a name that keepNames will wrap. */
const NAMED_FUNCTION = [
  /\b(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/,
  /\b(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/,
  /\bfunction\s+\w+\s*\(/,
];

const sources = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => [f, readFileSync(join(HERE, f), "utf8")] as const);

describe("code that runs inside the page", () => {
  it("has files to check", () => {
    // A guard whose glob silently matches nothing is worse than no guard.
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some(([, code]) => code.includes(".evaluate("))).toBe(true);
  });

  for (const [file, code] of sources) {
    it(`${file} declares no named functions inside evaluate()`, () => {
      for (const body of evaluateCallbacks(code)) {
        const clean = withoutComments(body);
        for (const pattern of NAMED_FUNCTION) {
          expect(
            pattern.test(clean),
            `${file}: a named function inside evaluate() compiles to __name(), which does not ` +
              `exist in the browser. Inline it or make it anonymous.\n\n${body.slice(0, 240)}`,
          ).toBe(false);
        }
      }
    });
  }
});

describe("the guard itself", () => {
  it("finds a named arrow function in an evaluate callback", () => {
    const bad = `await page.evaluate(() => { const seen = (e) => e.tagName; return seen(document.body); });`;
    const [body] = evaluateCallbacks(bad);
    expect(NAMED_FUNCTION.some((p) => p.test(withoutComments(body!)))).toBe(true);
  });

  it("finds a named function declaration", () => {
    const bad = `await page.evaluate(() => { function pick(e) { return e; } return pick(1); });`;
    const [body] = evaluateCallbacks(bad);
    expect(NAMED_FUNCTION.some((p) => p.test(withoutComments(body!)))).toBe(true);
  });

  it("accepts anonymous callbacks and plain locals", () => {
    const ok = `await page.evaluate(() => { const showing = el.offsetParent !== null; return [...xs].map((x) => x.id); });`;
    const [body] = evaluateCallbacks(ok);
    expect(NAMED_FUNCTION.some((p) => p.test(withoutComments(body!)))).toBe(false);
  });

  it("is not fooled by a bracket inside a selector string", () => {
    const ok = `await page.evaluate(() => document.querySelector('[role="option"]:not(.x)'));`;
    expect(evaluateCallbacks(ok)[0]).toContain("querySelector");
  });

  it("ignores prose in comments that describes the rule", () => {
    const ok = `await page.evaluate(() => { /* never write const seen = (e) => e */ return 1; });`;
    const [body] = evaluateCallbacks(ok);
    expect(NAMED_FUNCTION.some((p) => p.test(withoutComments(body!)))).toBe(false);
  });
});
