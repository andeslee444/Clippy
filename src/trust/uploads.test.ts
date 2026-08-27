import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUploadAllowed, UploadRefusedError, allowedUploadRoots } from "./uploads.js";

let base: string, docs: string, secrets: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "clippy-upload-"));
  docs = join(base, "Documents");
  secrets = join(base, "secrets");
  mkdirSync(docs);
  mkdirSync(secrets);
  mkdirSync(join(base, "Documents-secret"));
  writeFileSync(join(docs, "resume.pdf"), "cv");
  writeFileSync(join(secrets, "id_rsa"), "KEY");
  writeFileSync(join(base, "Documents-secret", "notes.txt"), "x");
  symlinkSync(join(secrets, "id_rsa"), join(docs, "innocent.pdf"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const allow = (p: string) => assertUploadAllowed(p, [docs]);

describe("assertUploadAllowed", () => {
  it("allows a file inside the root", () => {
    expect(allow(join(docs, "resume.pdf"))).toContain("resume.pdf");
  });

  it("refuses a file outside the root", () => {
    expect(() => allow(join(secrets, "id_rsa"))).toThrow(UploadRefusedError);
  });

  it("refuses traversal out of the root", () => {
    expect(() => allow(join(docs, "..", "secrets", "id_rsa"))).toThrow(UploadRefusedError);
  });

  it("refuses a symlink that ESCAPES the root", () => {
    // The file is literally inside Documents. Following it is not.
    expect(() => allow(join(docs, "innocent.pdf"))).toThrow(UploadRefusedError);
  });

  it("returns the resolved path, so callers cannot upload the unresolved one", () => {
    const real = allow(join(docs, ".", "resume.pdf"));
    expect(real.endsWith(join("Documents", "resume.pdf"))).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(() => allow(join(base, "Documents-secret", "notes.txt"))).toThrow(UploadRefusedError);
  });

  it("refuses a file that does not exist", () => {
    expect(() => allow(join(docs, "nope.pdf"))).toThrow(UploadRefusedError);
  });
});

describe("allowedUploadRoots", () => {
  it("defaults to the user's Documents folder", () => {
    expect(allowedUploadRoots({} as NodeJS.ProcessEnv)[0]).toMatch(/Documents$/);
  });

  it("has no setting that means 'anywhere'", () => {
    // An empty value falls back to the default rather than allowing all paths.
    expect(allowedUploadRoots({ CLIPPY_UPLOAD_ROOTS: "" } as NodeJS.ProcessEnv)[0]).toMatch(/Documents$/);
  });
});
