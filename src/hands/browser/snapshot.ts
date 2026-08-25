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
  /**
   * The page's visible prose, trimmed.
   *
   * The ref'd tree contains only INTERACTIVE elements, so a run could see every
   * form field and not one word of the job description. Asked to judge fit, the
   * model correctly reported it could not see the posting — the tree is the
   * right observation for acting and useless for reading.
   *
   * Capped, because §8.3's whole argument is that observation size dominates
   * cost. A few hundred tokens of prose is worth it; the full page is not.
   */
  text: string;
  /**
   * The page contains no `<form>` element, so `submitCapable` is unreliable here.
   *
   * Measured against real ATS platforms: a Workday job page has ZERO forms — it
   * is a SPA driving everything through click handlers — so `closest("form")`
   * returns null for every element and nothing gets flagged. Greenhouse, by
   * contrast, has a real form (declared `method="get"`, then submitted over XHR,
   * so form method is NOT a usable signal either).
   *
   * This flag surfaces the coverage gap rather than hiding it: the gate policy
   * can require approval for every click on a formless page.
   */
  formless: boolean;
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
  const { nodes, formless, text } = (await page.evaluate(
    ({ src, g }: { src: string; g: number }) => ({
      nodes: (new Function("return (" + src + ")")() as (d: Document, n: number) => unknown)(
        document,
        g,
      ),
      formless: document.querySelector("form") === null,
      text: (document.body?.innerText ?? "").slice(0, 2500),
    }),
    { src: PAGE_SCRIPT, g: gen },
  )) as { nodes: RefNode[]; formless: boolean; text: string };
  return { generation: gen, url: page.url(), title: await page.title(), nodes, formless, text };
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
  const prose = s.text.trim()
    ? ["", "## Page text", s.text.trim().replace(/\n{3,}/g, "\n\n")]
    : [];
  return [`# ${s.title}`, `# ${s.url}`, ...lines, ...prose].join("\n");
}
