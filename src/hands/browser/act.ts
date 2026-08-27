import { assertUploadAllowed } from "../../trust/uploads.js";
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

  let submittedFrom = "";
  switch (effect.kind) {
    case "click":
    case "submit":
      // Captured BEFORE the click: a submit that is accepted navigates away,
      // and that is the only reliable proof of acceptance.
      submittedFrom = page.url();
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
      // The RESOLVED path is uploaded, never `effect.path` — see uploads.ts.
      await locator.setInputFiles(assertUploadAllowed(effect.path));
      break;
  }
  await settle(page);
  if (effect.kind === "submit") await verifySubmitted(page, submittedFrom);
}

/**
 * Rejected by the form's own validation. The click worked; the submission did not.
 */
export class SubmitRejectedError extends Error {
  constructor(problems: string[]) {
    super(`the form rejected the submission: ${problems.join("; ")}`);
    this.name = "SubmitRejectedError";
  }
}

/** Phrasings a form uses to say a field is not acceptable. */
const VALIDATION =
  /\b(is required|are required|please (enter|select|provide|choose)|must be|cannot be (blank|empty)|invalid)\b|^select (a|an|your)\b/i;

/**
 * A submit the form rejected is a FAILURE, not a success.
 *
 * `fill` has had this since a 40-step loop was traced to fills that returned ok
 * having changed nothing. `submit` did not, and the consequence was worse: a
 * real application to a real posting reported DONE, and the model told the user
 * it had applied. The form had refused it — no résumé attached, location
 * unset — and every layer above believed the click.
 *
 * Two independent signals, because forms differ in which they use:
 *
 *   - `aria-invalid="true"`, which the form sets on the offending controls.
 *   - A short, visible message in the form's own validation phrasing.
 *
 * Both are read AFTER settle, so a successful submit that navigated to a
 * confirmation page has no controls left to be invalid and reports clean. The
 * length cap keeps the page's legal boilerplate — which contains the word
 * "required" in an unrelated sense — out of the signal.
 */
async function verifySubmitted(page: Page, from: string): Promise<void> {
  // A submit the form accepts navigates. Wait for that before reading the DOM.
  //
  // settle() returns while the OLD document is still on screen, and the old
  // document still holds the validation errors from the previous attempt. On a
  // real application this reported "Please enter your location" for a
  // submission Greenhouse had just accepted — the run ended STUCK, the audit
  // log recorded four rejections, and the confirmation page was already
  // loading. A false negative here is not a harmless conservative error: it
  // reads as "not sent", and the obvious response is to send it again.
  await page.waitForURL((u) => u.toString() !== from, { timeout: 5_000 }).catch(() => {});
  if (page.url() !== from) return;

  // NOTHING inside this callback may be a NAMED function. tsx/esbuild compiles
  // with keepNames, which rewrites `const seen = (e) => …` into
  // `__name((e) => …, "seen")` — and `__name` does not exist in the browser, so
  // the call throws ReferenceError at runtime while compiling and unit-testing
  // cleanly. This is the second time that trap has been sprung here; the first
  // cost a page script, and this one silently turned every submit into a
  // failure. Booleans and loops are fine. Named callbacks are not.
  const problems = await page.evaluate((pattern) => {
    const re = new RegExp(pattern.source, pattern.flags);
    const found: string[] = [];

    for (const el of document.querySelectorAll('[role="alert"], [class*="error" i]')) {
      const showing = (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0;
      if (!showing) continue;
      const text = (el.textContent ?? "").trim();
      if (text && text.length <= 160 && re.test(text)) found.push(text);
    }

    for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
      const name = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? el.id;
      if (name) found.push(`${name} was not accepted`);
    }

    return [...new Set(found)].slice(0, 10);
  }, { source: VALIDATION.source, flags: VALIDATION.flags });

  if (problems.length > 0) throw new SubmitRejectedError(problems);
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
  await locator.fill("").catch(() => undefined);

  // TYPED, not filled. fill() sets the value and dispatches a single input
  // event; an async combobox listens for keystrokes to start its debounced
  // search, so a filled value leaves the option list empty forever. Greenhouse's
  // location field never offered a single option until this changed.
  await locator.pressSequentially(value, { delay: 25 }).catch(() => undefined);

  // When a shorter retry is available, do not spend the full budget waiting for
  // a query that may be unanswerable — the retry is the likelier path.
  const head = value.split(",")[0]?.trim() ?? "";
  const canRetry = Boolean(head) && head !== value;
  let scope = await openListbox(page, canRetry ? 1_500 : 4_000);

  // A remote search takes the query literally. "New York, NY" matches nothing
  // in a places index that spells it "New York, New York, United States", so
  // the full value returns an empty list while its first segment returns nine
  // results. Retype the shorter query, which is what a person does.
  if (canRetry && (await scope.getByRole("option").count()) === 0) {
    await locator.fill("").catch(() => undefined);
    await locator.pressSequentially(head, { delay: 25 }).catch(() => undefined);
    scope = await openListbox(page);
  }

  // EXACT match, never substring. Playwright's hasText is a substring test, and
  // the value that broke this was "No" — a substring of "Not", "Now", "North",
  // and a third of the posting. It matched a job-description bullet, took the
  // first in DOM order, and timed out clicking something that is not an option.
  // A longer value would have worked by luck, which is how this survives
  // casual testing.
  const exact = scope.getByRole("option", { name: value, exact: true }).first();
  if ((await exact.count()) > 0 && (await pick(exact, locator))) return;

  // Looser fallback, still scoped to the open list rather than the document.
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loose = scope.getByRole("option", { name: new RegExp(`^\\s*${escaped}`, "i") }).first();
  if ((await loose.count()) > 0 && (await pick(loose, locator))) return;

  // Leading-segment match, for values that name the same thing at a different
  // precision. The profile says "New York, NY"; Greenhouse's location widget
  // offers "New York, New York, United States". Neither exact nor prefix
  // matches, and they are the same place.
  //
  // Narrow on purpose: it only runs when the value itself has a comma, and the
  // option's OWN leading segment must be identical — so "New York" will not
  // quietly settle for "New Rochelle, New York, United States".
  if (head && head !== value) {
    for (const option of await scope.getByRole("option").all()) {
      const text = (await option.innerText().catch(() => "")).trim();
      if (text.split(",")[0]?.trim().toLowerCase() !== head.toLowerCase()) continue;
      if (await pick(option, locator)) return;
    }
  }

  // Nothing matched. For a custom combobox the typed text sitting in the input
  // is NOT a selection, and verifyLanded — which reads inputValue — cannot tell
  // the difference. That is precisely how a location field reported
  // `select ok: New York, NY` and then blocked four consecutive submits.
  // Only a plain control may be verified by its value.
  if ((await displayedChoice(locator)) !== undefined) {
    throw new Error(
      `select ${ref}: typed "${value}" but no option was chosen — the control still shows nothing`,
    );
  }
  await verifyLanded(locator, value, ref);
}

/**
 * What a custom combobox is currently displaying.
 *
 * `undefined` means this is not one, and nothing here can speak to whether a
 * value landed. `""` means it is one and nothing is chosen. Distinguishing the
 * two is the whole point: the alternative is treating "cannot tell" as "fine".
 */
async function displayedChoice(control: Locator): Promise<string | undefined> {
  return await control
    .evaluate((el) => {
      const box = el.closest('[class*="select__control"], [class*="-control"]');
      if (!box) return undefined;
      const shown = box.querySelector('[class*="ingleValue"], [class*="ingle-value"]');
      return shown?.textContent?.trim() ?? "";
    })
    .catch(() => undefined);
}

/**
 * The listbox that just opened, once it actually holds options.
 *
 * Greenhouse's location field is an ASYNC combobox: typing triggers a debounced
 * request and the options land roughly 700ms later, with none present at click
 * time. The previous fixed 500ms wait therefore raced it every time — the model
 * saw an empty list, gave up, and four submits were rejected for a location it
 * had "successfully" selected. A longer fixed wait would have fixed this one
 * widget by padding every synchronous select with dead time, so this polls and
 * returns as soon as there is something to choose from.
 *
 * Scoping matters as much as timing: a real posting had 244 elements with
 * role="option", because the job description is full of list items and every
 * combobox renders into the DOM.
 */
async function openListbox(page: Page, timeout = 4_000): Promise<Locator> {
  const list = page
    .locator('[role="listbox"], [role="dialog"][aria-modal="true"]')
    .locator("visible=true")
    .last();

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await list.count()) > 0 && (await list.getByRole("option").count()) > 0) return list;
    await page.waitForTimeout(120);
  }
  // No listbox ever appeared: fall back to the document, for widgets that
  // render options without the role.
  return (await list.count()) > 0 ? list : page.locator("body");
}

/**
 * Click an option and report whether the control actually took it (§7.6).
 *
 * Clicking is not evidence. A run reported `select ok: New York, NY, United
 * States` and the form still refused to submit for a missing location — the
 * click landed on something, and the widget's state never changed.
 */
async function pick(option: Locator, control: Locator): Promise<boolean> {
  await option.click({ timeout: 5_000 }).catch(() => undefined);
  const shown = await displayedChoice(control);
  // undefined = not a custom combobox, so there is nothing to contradict the
  // click. Do not report a failure we cannot actually observe.
  return shown === undefined || shown !== "";
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
