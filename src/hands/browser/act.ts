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
  // One round trip for both facts. Anonymous arrow passed straight to Playwright,
  // so it is not subject to the serialisation hazard in §8.2.
  const facts = await locator.evaluate((el) => ({
    submitCapable: el.getAttribute("data-clippy-submit") === "1",
    formless: el.ownerDocument.querySelector("form") === null,
  }));
  return { locator, facts };
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
