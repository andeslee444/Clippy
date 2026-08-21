import { describe, it, expect } from "vitest";
import { captureWindow } from "./capture.js";

describe("captureWindow", () => {
  it("captures the whole page when it fits", () => {
    const w = captureWindow({ width: 1200, height: 3000, top: 100, bottom: 900 });
    expect(w).toEqual({ y: 0, width: 1200, height: 3000, truncated: false });
  });

  it("keeps a bottom-of-page form inside the window", () => {
    // Real Greenhouse posting: 10,167px tall, form at y=9193..10007.
    // A top-anchored clip returned the job description and none of the form.
    const w = captureWindow({ width: 1200, height: 10167, top: 9193, bottom: 10007 });
    expect(w.truncated).toBe(true);
    expect(w.y).toBeLessThanOrEqual(9193);
    expect(w.y + w.height).toBeGreaterThanOrEqual(10007);
  });

  it("never proposes a window past the end of the document", () => {
    const w = captureWindow({ width: 1200, height: 10167, top: 10000, bottom: 10167 });
    expect(w.y + w.height).toBeLessThanOrEqual(10167);
  });

  it("never proposes a negative offset", () => {
    const w = captureWindow({ width: 1200, height: 9000, top: 0, bottom: 50 });
    expect(w.y).toBeGreaterThanOrEqual(0);
  });

  it("falls back to the top when the page has no form controls", () => {
    expect(captureWindow({ width: 1200, height: 20000, top: null, bottom: null }).y).toBe(0);
  });

  it("caps width as well as height", () => {
    const w = captureWindow({ width: 4000, height: 500, top: null, bottom: null });
    expect(w.width).toBe(2000);
    expect(w.truncated).toBe(true);
  });
});
