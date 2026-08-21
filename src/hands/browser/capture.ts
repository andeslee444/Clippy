import type { Page } from "playwright-core";

/** Ceiling on the captured region, CSS pixels. Also the model's image limit. */
const MAX_HEIGHT = 8000;
const MAX_WIDTH = 2000;

export interface Capture {
  /** PNG bytes, base64. Goes to ActBrain as a native image block — never to Jenova (spec §5). */
  base64: string;
  width: number;
  height: number;
  /** Document-space y of the captured region's top. Non-zero when the page was too tall. */
  y: number;
  truncated: boolean;
}

export interface PageGeometry {
  width: number;
  height: number;
  /** Top of the form-control region, document space. Null when the page has none. */
  top: number | null;
  bottom: number | null;
}

/**
 * Choose the region to capture. Pure — the interesting logic, extracted so it
 * can be tested without a browser.
 *
 * When the page fits, capture all of it. When it does not, centre the window on
 * the form controls rather than anchoring at y=0: measured on a real Greenhouse
 * posting, the page is 10,167px tall with the form at y=9193–10007, so a
 * top-anchored clip returned the job description and none of the form.
 */
export function captureWindow(geom: PageGeometry): {
  y: number;
  width: number;
  height: number;
  truncated: boolean;
} {
  const truncated = geom.height > MAX_HEIGHT || geom.width > MAX_WIDTH;
  const width = Math.min(geom.width, MAX_WIDTH);
  const height = Math.min(geom.height, MAX_HEIGHT);

  let y = 0;
  if (geom.height > MAX_HEIGHT && geom.top !== null && geom.bottom !== null) {
    const centre = (geom.top + geom.bottom) / 2;
    y = Math.max(0, Math.min(Math.round(centre - height / 2), geom.height - height));
  }
  return { y, width, height, truncated };
}

/**
 * Full-page screenshot for comprehension (spec §8.2).
 *
 * The image is for DECIDING. Actions still cite refs from readPage(), never
 * coordinates read off this image.
 *
 * When the page exceeds MAX_HEIGHT the window is centred on the INTERACTIVE
 * region, not anchored at the top. Measured on a real Greenhouse posting: the
 * page is 10,167px tall and the application form sits at y=9193–10007, so a
 * top-anchored 8000px clip returned the job description and none of the form —
 * on precisely the page type this function exists to help with.
 */
export async function capturePage(page: Page): Promise<Capture> {
  const geom = await page.evaluate(() => {
    const doc = document.documentElement;
    // Form CONTROLS, not every clickable thing. Buttons and links are scattered
    // across a page (nav at the top, Submit at the bottom), so their union spans
    // nearly the whole document and centring on it lands between them. Text
    // inputs and selects cluster where the form actually is.
    const fields = "input:not([type=hidden]), textarea, select, [contenteditable=true]";
    const els = document.querySelectorAll(
      document.querySelector(fields) ? fields : "button, [role=button]",
    );
    let top = Infinity;
    let bottom = -Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      top = Math.min(top, r.top + window.scrollY);
      bottom = Math.max(bottom, r.bottom + window.scrollY);
    }
    return {
      width: doc.scrollWidth,
      height: doc.scrollHeight,
      top: Number.isFinite(top) ? Math.floor(top) : null,
      bottom: Number.isFinite(bottom) ? Math.ceil(bottom) : null,
    };
  });

  const { y, width, height, truncated } = captureWindow(geom);

  const buf = await page.screenshot({
    type: "png",
    // `fullPage` is required even WITH `clip`. Without it Playwright trims the
    // clip to the viewport and leaves captureBeyondViewport off — returning a
    // viewport screenshot mislabelled as a full-page one.
    fullPage: true,
    clip: { x: 0, y, width, height },
    // Default is "device": on a Retina display an 8000 CSS-px clip yields a
    // 16000 px PNG, over the model's image limit, with returned dimensions that
    // do not match the encoded image.
    scale: "css",
  });

  return { base64: buf.toString("base64"), width, height, y, truncated };
}
