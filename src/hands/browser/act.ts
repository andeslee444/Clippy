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
