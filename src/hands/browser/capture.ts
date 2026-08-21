import type { Page } from "playwright-core";

/** Hard ceiling on the stitched screenshot's height, in CSS pixels. */
const MAX_HEIGHT = 8000;

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

  const truncated = dims.height > MAX_HEIGHT;
  const height = Math.min(dims.height, MAX_HEIGHT);

  const buf = await page.screenshot({
    type: "png",
    ...(truncated
      ? { clip: { x: 0, y: 0, width: dims.width, height } }
      : { fullPage: true }),
  });

  return { base64: buf.toString("base64"), width: dims.width, height, truncated };
}
