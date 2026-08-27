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
      await verifyLanded(locator, effect.value, effect.ref);
      break;
    case "select":
      await selectAnything(page, locator, effect.value, effect.ref);
      break;
    case "upload":
      await locator.setInputFiles(effect.path);
      break;
  }
  await settle(page);
}

/**
 * A fill that changed nothing is a FAILURE, not a success.
 *
 * Custom widgets — the "comboboxes" every ATS builds out of an input and a
 * listbox — accept `fill()` without error and discard the value. Reporting that
 * as `ok` breaks the contract the whole loop rests on: the model retries on
 * failure and moves on after success, so a truthful-looking no-op makes it fill
 * the same field forever. Observed live on a Discord posting: 27 page reads,
 * 36 fills, step budget exhausted.
 *
 * Only emptiness counts as failure. Fields legitimately transform what you type
 * — phone numbers get reformatted, dates normalised — so requiring an exact
 * match back would reject good writes.
 */
async function verifyLanded(locator: Locator, value: string, ref: Ref): Promise<void> {
  if (!value) return;
  const after = await locator.inputValue().catch(() => null);
  if (after !== null && after.trim() === "") {
    throw new Error(
      `fill on ${ref} did not take: the field is still empty. It is probably a custom ` +
        `widget, not a plain input — try select, or click it and choose from the list.`,
    );
  }
}

/**
 * Choose an option whether or not the element is a real `<select>`.
 *
 * `selectOption` only works on `<select>`. Greenhouse, Lever and Workday all
 * render dropdowns as an input plus a listbox, so the model sees "combobox",
 * reasonably calls select, and gets "Element is not a <select>".
 *
 * Presenting one verb that works on both is `hands`' job. Pushing the DOM
 * distinction up to the model means teaching it a detail it cannot reliably
 * observe from the tree.
 */
async function selectAnything(
  page: Page,
  locator: Locator,
  value: string,
  ref: Ref,
): Promise<void> {
  try {
    await locator.selectOption(value, { timeout: 3_000 });
    return;
  } catch (err) {
    if (!/not a <select>|Element is not a/i.test(String(err))) throw err;
  }

  // Custom widget: click it, type to filter, then click the matching option.
  await locator.click().catch(() => undefined);
  await locator.fill(value).catch(() => undefined);
  await page.waitForTimeout(500);

  // Scope to the listbox that just OPENED, not the whole page. A real posting
  // had 244 elements with role="option" — the job description is full of <li>
  // bullets and every combobox renders its options into the DOM.
  const openList = page
    .locator('[role="listbox"], [role="dialog"][aria-modal="true"]')
    .locator("visible=true")
    .last();
  const scope = (await openList.count()) > 0 ? openList : page;

  // EXACT match, never substring. Playwright's hasText is a substring test, and
  // the value that broke this was "No" — a substring of "Not", "Now", "North",
  // and a third of the posting. It matched a job-description bullet, took the
  // first in DOM order, and timed out clicking something that is not an option.
  // A longer value would have worked by luck, which is how this survives
  // casual testing.
  const exact = scope.getByRole("option", { name: value, exact: true }).first();
  if ((await exact.count()) > 0) {
    await exact.click({ timeout: 5_000 });
    return;
  }

  // Looser fallback, still scoped to the open list rather than the document.
  const loose = scope.getByRole("option", { name: new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i") }).first();
  if ((await loose.count()) > 0) {
    await loose.click({ timeout: 5_000 });
    return;
  }

  await verifyLanded(locator, value, ref);
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
