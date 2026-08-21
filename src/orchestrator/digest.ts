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
