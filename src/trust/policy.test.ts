import { describe, it, expect } from "vitest";
import { isGated } from "./policy.js";
import type { Effect } from "../hands/types.js";

const e = (x: Effect) => x;

describe("isGated", () => {
  it("gates submit", () => {
    expect(isGated(e({ kind: "submit", ref: "g1-r1" }))).toBe(true);
  });

  it("gates upload — ATS platforms upload on attach", () => {
    expect(isGated(e({ kind: "upload", ref: "g1-r1", path: "/x/cv.docx" }))).toBe(true);
  });

  it("does not gate ordinary form interaction", () => {
    expect(isGated(e({ kind: "fill", ref: "g1-r2", value: "Andes" }))).toBe(false);
    expect(isGated(e({ kind: "select", ref: "g1-r4", value: "Yes" }))).toBe(false);
  });

  it("does not gate navigation", () => {
    expect(isGated(e({ kind: "navigate", url: "https://boards.greenhouse.io/x" }))).toBe(false);
  });

  it("does not gate a click on an ordinary control", () => {
    expect(isGated(e({ kind: "click", ref: "g1-r3" }), { submitCapable: false, formAssociated: true })).toBe(false);
  });

  it("GATES a click on a submit-capable element — the kind is model-supplied", () => {
    expect(isGated(e({ kind: "click", ref: "g1-r3" }), { submitCapable: true, formAssociated: true })).toBe(true);
  });

  it("GATES any click on a form-less page — submitCapable cannot detect there", () => {
    // Measured: a real Workday job page has zero <form> elements, so
    // closest("form") flags nothing, including the real submit button.
    expect(isGated(e({ kind: "click", ref: "g1-r3" }), { submitCapable: false, formAssociated: false })).toBe(true);
  });

  it("does not gate non-click effects on a form-less page", () => {
    expect(isGated(e({ kind: "fill", ref: "g1-r2", value: "x" }), { submitCapable: false, formAssociated: false })).toBe(false);
  });

  it("is pure", () => {
    const a = e({ kind: "submit", ref: "g1-r1" });
    expect(isGated(a)).toBe(isGated(a));
  });
});
