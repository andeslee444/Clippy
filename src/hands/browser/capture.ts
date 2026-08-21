import type { Page } from "playwright-core";

/** Ceiling on the captured region, CSS pixels. Also the model's image limit. */
const MAX_HEIGHT = 8000;
const MAX_WIDTH = 2000;

export interface Capture {
  /** PNG bytes, base64. Goes to ActBrain as a native image block — never to Jenova (spec §5). */
  base64: string;
  width: number;
  height: number;
  truncated: boolean;
}

/**
 * Full-page screenshot for comprehension (spec §8.2).
 *
 * The image is for DECIDING. Actions still cite refs from readPage(), never
 * coordinates read off this image.
 */
export async function capturePage(page: Page): Promise<Capture> {
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));

  const truncated = dims.height > MAX_HEIGHT || dims.width > MAX_WIDTH;
  const width = Math.min(dims.width, MAX_WIDTH);
  const height = Math.min(dims.height, MAX_HEIGHT);

  const buf = await page.screenshot({
    type: "png",
    // `fullPage` is required even WITH `clip`. Without it Playwright trims the
    // clip to the viewport and leaves captureBeyondViewport off — returning a
    // viewport screenshot mislabelled as a full-page one.
    fullPage: true,
    clip: { x: 0, y: 0, width, height },
    // Default is "device": on a Retina display an 8000 CSS-px clip yields a
    // 16000 px PNG, over the model's image limit, with returned dimensions that
    // do not match the encoded image.
    scale: "css",
  });

  return { base64: buf.toString("base64"), width, height, truncated };
}
