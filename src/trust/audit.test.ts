import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "./audit.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "clippy-audit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("AuditLog", () => {
  it("writes an attempt line before the action runs", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    await log.attempt({ kind: "fill", ref: "g1-r2", value: "Andes" }, { gated: false });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.phase).toBe("attempt");
    expect(entry.action.kind).toBe("fill");
    expect(entry.gated).toBe(false);
    expect(typeof entry.ts).toBe("number");
    expect(typeof entry.seq).toBe("number");
  });

  it("appends an outcome line after, sharing the attempt's seq", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    const seq = await log.attempt({ kind: "click", ref: "g1-r3" }, { gated: false });
    await log.outcome(seq, { ok: true });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ phase: "outcome", seq, ok: true });
  });

  it("records failures with the error message", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    const seq = await log.attempt({ kind: "click", ref: "g1-r9" }, { gated: false });
    await log.outcome(seq, { ok: false, error: "stale ref" });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({ ok: false, error: "stale ref" });
  });

  it("never rewrites earlier lines", async () => {
    const log = new AuditLog(join(dir, "run.jsonl"));
    const a = await log.attempt({ kind: "readPage" }, { gated: false });
    await log.outcome(a, { ok: true });
    const b = await log.attempt({ kind: "capturePage" }, { gated: false });
    await log.outcome(b, { ok: true });

    const lines = (await readFile(join(dir, "run.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]!).action.kind).toBe("readPage");
  });
});
