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
