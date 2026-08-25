import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("build layout", () => {
  it("keeps page-script.js as a standalone file, not inlined", () => {
    // The whole point: snapshot.ts reads this from disk at runtime. Any build
    // that inlines it reintroduces the bundler-injected-helper bug that shipped
    // in Plan 1 (`__name is not defined` inside the page).
    const src = readFileSync("src/hands/browser/snapshot.ts", "utf8");
    expect(src).toContain("readFileSync");
    expect(src).toContain("page-script.js");
  });

  it("carries no bundler helper call sites in the page script", () => {
    const js = readFileSync("src/hands/browser/page-script.js", "utf8");
    expect(js).not.toMatch(/__name\s*\(|__spreadValues\s*\(|__async\s*\(/);
  });

  it("copies page-script.js beside the compiled snapshot when built", () => {
    // Skipped when dist/ is absent so the suite still runs without a build.
    if (!existsSync("dist/hands/browser/snapshot.js")) return;
    expect(existsSync("dist/hands/browser/page-script.js")).toBe(true);
  });
});
