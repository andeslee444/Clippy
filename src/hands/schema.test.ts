import { describe, it, expect } from "vitest";
import { parseEffect, RefSchema } from "./schema.js";

describe("RefSchema", () => {
  it("accepts a well-formed ref", () => {
    expect(RefSchema.safeParse("g3-r12").success).toBe(true);
  });

  it("rejects a ref carrying a selector injection", () => {
    // This exact string produces:  [data-clippy-ref="g1-r0"], button[type="submit"]
    // — a valid selector matching the Submit button.
    expect(RefSchema.safeParse(`g1-r0"], button[type="submit`).success).toBe(false);
  });

  it("rejects refs with quotes, brackets, spaces, or wildcards", () => {
    for (const bad of [`g1-r0"`, "g1-r0]", "g1 r0", "*", "g1-r0 ", "", "grr"]) {
      expect(RefSchema.safeParse(bad).success, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe("parseEffect", () => {
  it("accepts a valid click", () => {
    expect(parseEffect({ kind: "click", ref: "g1-r3" })).toEqual({ kind: "click", ref: "g1-r3" });
  });

  it("rejects file:// navigation — local file exfiltration", () => {
    expect(() => parseEffect({ kind: "navigate", url: "file:///Users/a/.aws/credentials" })).toThrow();
  });

  it("rejects non-http schemes", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://settings"]) {
      expect(() => parseEffect({ kind: "navigate", url }), url).toThrow();
    }
  });

  it("accepts https navigation", () => {
    expect(parseEffect({ kind: "navigate", url: "https://boards.greenhouse.io/x" })).toBeTruthy();
  });

  it("rejects an upload outside the allowed directory", () => {
    expect(() => parseEffect({ kind: "upload", ref: "g1-r1", path: "/Users/a/.ssh/id_rsa" })).toThrow();
  });

  it("rejects an upload escaping the allowed directory via ..", () => {
    expect(() =>
      parseEffect({ kind: "upload", ref: "g1-r1", path: `${process.cwd()}/documents/../../.ssh/id_rsa` }),
    ).toThrow();
  });

  it("accepts an upload inside the allowed directory", () => {
    // The roots are read at call time, so the test states its own.
    process.env.CLIPPY_UPLOAD_ROOTS = "/tmp/clippy-docs";
    try {
      const ok = parseEffect({ kind: "upload", ref: "g1-r1", path: "/tmp/clippy-docs/cv.docx" });
      expect(ok.kind).toBe("upload");
    } finally {
      delete process.env.CLIPPY_UPLOAD_ROOTS;
    }
  });

  it("rejects an upload from outside the allowed directory", () => {
    process.env.CLIPPY_UPLOAD_ROOTS = "/tmp/clippy-docs";
    try {
      expect(() => parseEffect({ kind: "upload", ref: "g1-r1", path: "/etc/hosts" })).toThrow();
      // A sibling sharing the prefix is outside, and the separator says so.
      expect(() => parseEffect({ kind: "upload", ref: "g1-r1", path: "/tmp/clippy-docs-secret/x" })).toThrow();
    } finally {
      delete process.env.CLIPPY_UPLOAD_ROOTS;
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => parseEffect({ kind: "evaluate", script: "fetch('/x')" })).toThrow();
  });
});
