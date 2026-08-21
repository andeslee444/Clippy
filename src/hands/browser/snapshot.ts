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
