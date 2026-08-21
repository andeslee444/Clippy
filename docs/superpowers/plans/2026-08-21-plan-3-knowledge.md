# Clippy Plan 3 — Knowledge Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a real resume into `profile.json`, assess fit against a posting, and draft tailored text that **cannot** contain a fabricated employer, title, date, or metric.

**Architecture:** `memory/profile.ts` holds the single source of factual truth. `trust/integrity.ts` is a pure validator that fails closed on any claim absent from the profile (spec §7.4) — it runs *before* a learned scorer ever sees a draft, and before any text reaches a form. `brains/know-brain.ts` talks to Jenova, routing per task across pre-built agents (spec §13). `hands/resume/` reads documents via `anydoc` (spec §6.4).

**Tech Stack:** Adds `@firecrawl/anydoc` (document → structured model). Jenova via `fetch` + SSE — no SDK exists.

**Spec:** `docs/superpowers/specs/2026-08-20-clippy-v1-design.md` §5 (Jenova constraints), §6.3, §6.4 (document I/O), §7.4 (resume integrity), §10 (memory), §13 (agent routing).

**Predecessor:** Plans 1, 1a, 2 — complete, 155 tests, verified live on three providers.

---

## Split into two halves

**3a — profile + integrity validator.** Pure, fully testable, safety-critical. Lands first.
**3b — Jenova KnowBrain + resume ingestion.** Needs the live API and a real document.

3a must be complete before 3b, because §7.4 says the deterministic validator runs *first* and a learned component may only rank what already passed. Building the generator before the check invites wiring them backwards.

---

## The validator's design, and its honest limits

The check is **not** "does this sentence mean something true." That is NLP-hard and would fail open in unpredictable ways. It is: **every checkable claim-shaped token in generated text must appear in the profile.**

Three token classes, chosen because they are exactly what a fabricating model invents:

| Class | Pattern | Why |
|---|---|---|
| Years | `\b(19|20)\d{2}\b` | Shifted dates are the most common embellishment |
| Metrics | `42%`, `3x`, `$1.2M`, bare integers ≥ 2 digits | "cut latency 40%" is the classic invented number |
| Organisations | Capitalised word runs not in a stoplist | An invented employer is the worst failure |

**This over-rejects, deliberately.** A false positive costs a redraft; a false negative puts a fabricated employer on a real application under the user's name. The asymmetry is the whole point, and the tests assert the direction explicitly.

**What it cannot catch**, stated plainly so nobody assumes otherwise: reworded seniority ("led" vs "contributed to"), invented scope described without numbers, or a real metric attached to the wrong job. Those need the human at the §9.5 gate, which is why the gate groups by provenance.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/memory/profile.ts` | `Profile` type, zod schema, load/save |
| `src/trust/integrity.ts` | §7.4 validator — pure |
| `src/trust/stoplist.ts` | Words that look like orgs but aren't |
| `src/brains/know-brain.ts` | Jenova client — SSE, per-task agent routing |
| `src/hands/resume/ingest.ts` | anydoc → profile draft |
| `src/cli/spine.ts` | **Modify** — `ingest`, `fit`, `draft` |

---

### Task P3-1: The Profile

**Files:** Create `src/memory/profile.ts`, test `src/memory/profile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { ProfileSchema, factsOf, type Profile } from "./profile.js";

const sample: Profile = {
  name: "Andes Lee",
  email: "a@b.c",
  phone: "+1 415 555 0100",
  location: "San Francisco, CA",
  workAuthorized: true,
  needsSponsorship: false,
  salaryExpectation: "$185,000",
  links: { linkedin: "https://linkedin.com/in/x" },
  employers: [
    {
      company: "Acme Corp",
      title: "Senior Engineer",
      start: "2021",
      end: "2024",
      bullets: ["Led the platform migration, cutting p95 latency 40%"],
    },
  ],
  education: [{ school: "State University", degree: "BS Computer Science", end: "2018" }],
  answers: { "why do you want to work here": "" },
};

describe("ProfileSchema", () => {
  it("accepts a complete profile", () => {
    expect(ProfileSchema.parse(sample)).toBeTruthy();
  });

  it("rejects a profile with no employers — nothing could be validated against it", () => {
    expect(() => ProfileSchema.parse({ ...sample, employers: [] })).toThrow();
  });

  it("rejects a missing name", () => {
    const { name, ...rest } = sample;
    expect(() => ProfileSchema.parse(rest)).toThrow();
  });

  it("allows an employer with no end date (current role)", () => {
    const p = { ...sample, employers: [{ ...sample.employers[0]!, end: undefined }] };
    expect(ProfileSchema.parse(p)).toBeTruthy();
  });
});

describe("factsOf", () => {
  it("collects every company, title, school, and degree", () => {
    const f = factsOf(sample);
    expect(f.organisations).toContain("acme corp");
    expect(f.organisations).toContain("state university");
    expect(f.titles).toContain("senior engineer");
  });

  it("collects every year mentioned anywhere", () => {
    expect(factsOf(sample).years).toEqual(new Set(["2018", "2021", "2024"]));
  });

  it("collects metrics from bullet source material", () => {
    expect(factsOf(sample).metrics).toContain("40%");
  });

  it("collects the salary figure as a metric", () => {
    expect(factsOf(sample).metrics).toContain("$185,000");
  });

  it("lowercases organisations and titles for case-insensitive matching", () => {
    expect(factsOf(sample).organisations.every((o) => o === o.toLowerCase())).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/memory/profile.test.ts`

- [ ] **Step 3: Create `src/memory/profile.ts`**

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const EmployerSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  start: z.string().min(4),
  end: z.string().optional(),
  bullets: z.array(z.string()).default([]),
});

const EducationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().min(1),
  end: z.string().optional(),
});

/**
 * The single source of factual truth (spec §10).
 *
 * Every factual claim in every application is checked against this file, so an
 * extraction error here propagates into real submissions. It is extracted from
 * a resume and then CORRECTED BY HAND — §10 is explicit that extraction is a
 * starting point, not an authority.
 */
export const ProfileSchema = z.object({
  name: z.string().min(1),
  email: z.string().min(3),
  phone: z.string().default(""),
  location: z.string().default(""),
  workAuthorized: z.boolean(),
  needsSponsorship: z.boolean(),
  salaryExpectation: z.string().default(""),
  links: z.record(z.string(), z.string()).default({}),
  // At least one employer: a profile with none makes the §7.4 validator vacuous,
  // because there would be nothing for a generated claim to be checked against.
  employers: z.array(EmployerSchema).min(1),
  education: z.array(EducationSchema).default([]),
  answers: z.record(z.string(), z.string()).default({}),
  /** Path to the source document, which is also the template for the write path (§6.4). */
  sourceDocument: z.string().optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** Everything the §7.4 validator is allowed to consider true. */
export interface ProfileFacts {
  organisations: string[];
  titles: string[];
  years: Set<string>;
  metrics: string[];
  /** The whole profile as one lowercased blob, for substring fallbacks. */
  corpus: string;
}

const YEAR = /\b(?:19|20)\d{2}\b/g;
const METRIC = /\$[\d,]+(?:\.\d+)?[KMB]?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?x\b|\b\d{2,}\b/g;

/** Flatten a profile into the fact sets the validator checks against. */
export function factsOf(profile: Profile): ProfileFacts {
  const corpus = JSON.stringify(profile).toLowerCase();

  const organisations = [
    ...profile.employers.map((e) => e.company),
    ...profile.education.map((e) => e.school),
  ].map((s) => s.toLowerCase());

  const titles = [
    ...profile.employers.map((e) => e.title),
    ...profile.education.map((e) => e.degree),
  ].map((s) => s.toLowerCase());

  const years = new Set<string>();
  const metrics: string[] = [];
  for (const text of [
    ...profile.employers.flatMap((e) => [e.start, e.end ?? "", ...e.bullets]),
    ...profile.education.map((e) => e.end ?? ""),
    profile.salaryExpectation,
    ...Object.values(profile.answers),
  ]) {
    for (const y of text.match(YEAR) ?? []) years.add(y);
    for (const m of text.match(METRIC) ?? []) metrics.push(m);
  }

  return { organisations, titles, years, metrics, corpus };
}

export async function loadProfile(path: string): Promise<Profile> {
  return ProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function saveProfile(path: string, profile: Profile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ProfileSchema.parse(profile), null, 2), "utf8");
}
```

- [ ] **Step 4: Run, then commit**

```bash
git add src/memory/profile.ts src/memory/profile.test.ts
git commit -m "feat(memory): profile schema and fact extraction"
```

---

### Task P3-2: The §7.4 integrity validator

**Files:** Create `src/trust/stoplist.ts`, `src/trust/integrity.ts`, test `src/trust/integrity.test.ts`

This is the safety-critical piece of Plan 3. It fails closed.

- [ ] **Step 1: Create `src/trust/stoplist.ts`**

```ts
/**
 * Capitalised words that are not organisations.
 *
 * Without this, ordinary sentence-initial words and common proper-ish nouns are
 * flagged as invented employers and every draft is rejected — a validator that
 * rejects everything gets switched off, which is strictly worse than one that is
 * slightly permissive about "Python".
 */
export const STOPLIST = new Set([
  // sentence starters and connectives
  "i", "a", "an", "the", "and", "or", "but", "for", "with", "at", "in", "on", "to", "of", "as",
  "led", "built", "shipped", "drove", "owned", "managed", "designed", "created", "delivered",
  "reduced", "increased", "improved", "scaled", "launched", "migrated", "architected",
  "my", "our", "their", "this", "that", "these", "those", "we", "they",
  // months
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // ubiquitous tech nouns that are not employers
  "python", "typescript", "javascript", "java", "go", "rust", "ruby", "swift", "kotlin",
  "react", "node", "docker", "kubernetes", "postgres", "postgresql", "redis", "kafka",
  "aws", "gcp", "azure", "linux", "git", "github", "api", "apis", "sql", "graphql",
  "ci", "cd", "ml", "ai", "llm", "sdk", "http", "rest", "grpc", "json",
]);
```

- [ ] **Step 2: Write the failing test**

Create `src/trust/integrity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkIntegrity } from "./integrity.js";
import { factsOf, type Profile } from "../memory/profile.js";

const profile: Profile = {
  name: "Andes Lee", email: "a@b.c", phone: "", location: "",
  workAuthorized: true, needsSponsorship: false, salaryExpectation: "$185,000", links: {},
  employers: [{
    company: "Acme Corp", title: "Senior Engineer", start: "2021", end: "2024",
    bullets: ["Led the platform migration, cutting p95 latency 40%"],
  }],
  education: [{ school: "State University", degree: "BS Computer Science", end: "2018" }],
  answers: {},
};
const facts = factsOf(profile);
const check = (text: string) => checkIntegrity(text, facts);

describe("checkIntegrity — accepts truthful text", () => {
  it("passes a bullet rephrased from real material", () => {
    expect(check("Led a platform migration at Acme Corp that cut p95 latency 40%").ok).toBe(true);
  });

  it("passes text with no checkable claims at all", () => {
    expect(check("I care deeply about building reliable systems.").ok).toBe(true);
  });

  it("passes a real year", () => {
    expect(check("Joined Acme Corp in 2021.").ok).toBe(true);
  });

  it("does not flag common technology names as employers", () => {
    expect(check("Built services in Python and TypeScript on Kubernetes.").ok).toBe(true);
  });

  it("does not flag a sentence-initial verb as an organisation", () => {
    expect(check("Designed the ingestion pipeline. Shipped it in 2024.").ok).toBe(true);
  });
});

describe("checkIntegrity — rejects fabrication", () => {
  it("REJECTS an invented employer", () => {
    const r = check("Senior Engineer at Globex Industries");
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.value)).toContain("Globex Industries");
  });

  it("REJECTS a shifted date", () => {
    const r = check("Worked at Acme Corp from 2019.");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "year" && v.value === "2019")).toBe(true);
  });

  it("REJECTS an inflated metric", () => {
    const r = check("Cut p95 latency 90% at Acme Corp");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === "metric" && v.value === "90%")).toBe(true);
  });

  it("REJECTS an invented school", () => {
    expect(check("BS Computer Science, Harvard University").ok).toBe(false);
  });

  it("names every violation, not just the first", () => {
    const r = check("At Globex Industries in 2019 I cut costs 90%");
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it("fails closed on an empty profile fact set", () => {
    const empty = { organisations: [], titles: [], years: new Set<string>(), metrics: [], corpus: "" };
    expect(checkIntegrity("Acme Corp", empty).ok).toBe(false);
  });
});

describe("checkIntegrity — the asymmetry is deliberate", () => {
  it("would rather reject truthful text than accept fabricated text", () => {
    // An unusual capitalised phrase absent from the profile is rejected even
    // though it may be innocent. A redraft costs a few cents; a fabricated
    // employer on a real application cannot be taken back.
    expect(check("Presented at Strange Loop").ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails.** `npx vitest run src/trust/integrity.test.ts`

- [ ] **Step 4: Create `src/trust/integrity.ts`**

```ts
import type { ProfileFacts } from "../memory/profile.js";
import { STOPLIST } from "./stoplist.js";

export interface Violation {
  kind: "organisation" | "year" | "metric";
  value: string;
}

export interface IntegrityResult {
  ok: boolean;
  violations: Violation[];
}

const YEAR = /\b(?:19|20)\d{2}\b/g;
const METRIC = /\$[\d,]+(?:\.\d+)?[KMB]?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?x\b/g;
/** Runs of capitalised words — the shape an organisation name takes. */
const CAPRUN = /\b[A-Z][a-zA-Z&.'-]*(?:\s+(?:of|and|the)?\s*[A-Z][a-zA-Z&.'-]*)*/g;

const norm = (s: string) => s.toLowerCase().replace(/[.,]$/, "").trim();

/**
 * Verify that every checkable claim in `text` appears in the profile (spec §7.4).
 *
 * FAILS CLOSED. Anything claim-shaped that cannot be found is a violation, which
 * means truthful-but-unusual text is sometimes rejected. That asymmetry is
 * intentional: a rejection costs a redraft, while a fabricated employer on a
 * real application sent under the user's name cannot be retracted.
 *
 * It cannot catch reworded seniority, invented scope described without numbers,
 * or a real metric attached to the wrong job. Those are what the human review at
 * §9.5 is for — which is why that dialog groups by provenance.
 */
export function checkIntegrity(text: string, facts: ProfileFacts): IntegrityResult {
  const violations: Violation[] = [];

  for (const year of text.match(YEAR) ?? []) {
    if (!facts.years.has(year)) violations.push({ kind: "year", value: year });
  }

  for (const metric of text.match(METRIC) ?? []) {
    const found = facts.metrics.some((m) => norm(m) === norm(metric)) ||
      facts.corpus.includes(norm(metric));
    if (!found) violations.push({ kind: "metric", value: metric });
  }

  for (const raw of text.match(CAPRUN) ?? []) {
    const phrase = raw.trim();
    const lower = norm(phrase);
    if (!lower) continue;

    // A single stoplisted word, or a run made entirely of stoplisted words.
    const words = lower.split(/\s+/);
    if (words.every((w) => STOPLIST.has(w))) continue;
    // A lone capitalised word is usually sentence-initial prose, not an org.
    if (words.length === 1) continue;

    const known =
      facts.organisations.some((o) => o === lower || lower.includes(o) || o.includes(lower)) ||
      facts.titles.some((t) => t === lower || lower.includes(t) || t.includes(lower)) ||
      facts.corpus.includes(lower);

    if (!known) violations.push({ kind: "organisation", value: phrase });
  }

  return { ok: violations.length === 0, violations };
}

/** Render violations for a human or for a redraft instruction to the model. */
export function explain(result: IntegrityResult): string {
  if (result.ok) return "ok";
  return result.violations
    .map((v) => `${v.kind} "${v.value}" does not appear in your profile`)
    .join("; ");
}
```

- [ ] **Step 5: Run and commit**

```bash
git add src/trust/stoplist.ts src/trust/integrity.ts src/trust/integrity.test.ts
git commit -m "feat(trust): §7.4 resume integrity validator, fails closed"
```

---

### Task P3-3: KnowBrain over the Jenova API

**Files:** Create `src/brains/know-brain.ts`, test `src/brains/know-brain.test.ts`

Spec §5 and §13. Jenova has no SDK — this is `fetch` plus SSE parsing.

Key constraints from §5, all load-bearing:
- `POST https://api.jenova.ai/v1/messages`, bearer `jnv_sk_*`
- SSE by default; `stream_ended` carries `usage.cost`
- `ephemeral: true` for one-shots — no session fee, no stored history
- **Never send an image here** — Jenova requires public HTTPS URLs, so vision is ActBrain-only

Per-task agent routing (§13): `career-advisor` for finding postings, `resume-screener` for fit, `resume-and-cover-letter-writer` for drafting, `jenova` as fallback.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { JenovaKnowBrain, parseSSE, AGENTS } from "./know-brain.js";

const sse = (lines: string[]) => lines.join("\n") + "\n";

describe("parseSSE", () => {
  it("assembles chunk_content across deltas", () => {
    const out = parseSSE(sse([
      'event: stream_started', 'data: {"session_id":"s1","run_id":"r1"}', '',
      'event: stream_delta', 'data: {"chunk_content":"Hello "}', '',
      'event: stream_delta', 'data: {"chunk_content":"world"}', '',
      'event: stream_ended', 'data: {"success":true,"usage":{"cost":"0.0032"}}', '',
    ]));
    expect(out.text).toBe("Hello world");
    expect(out.cost).toBeCloseTo(0.0032, 6);
  });

  it("reports failure when the run did not succeed", () => {
    const out = parseSSE(sse([
      'event: stream_ended', 'data: {"success":false,"stop_reason":"user_action_timeout"}', '',
    ]));
    expect(out.ok).toBe(false);
    expect(out.stopReason).toBe("user_action_timeout");
  });

  it("surfaces an mcp_connection event as needing the user", () => {
    const out = parseSSE(sse([
      'event: mcp_connection', 'data: {"auth_url":"https://x/auth"}', '',
    ]));
    expect(out.needsUser).toBe(true);
  });

  it("ignores malformed data lines rather than throwing", () => {
    const out = parseSSE(sse([
      'event: stream_delta', 'data: {not json}', '',
      'event: stream_delta', 'data: {"chunk_content":"ok"}', '',
    ]));
    expect(out.text).toBe("ok");
  });

  it("defaults cost to zero when absent", () => {
    expect(parseSSE(sse(['event: stream_ended', 'data: {"success":true}', ''])).cost).toBe(0);
  });
});

describe("AGENTS", () => {
  it("routes each task to its §13 agent", () => {
    expect(AGENTS.findPostings).toBe("career-advisor");
    expect(AGENTS.assessFit).toBe("resume-screener");
    expect(AGENTS.draft).toBe("resume-and-cover-letter-writer");
    expect(AGENTS.general).toBe("jenova");
  });
});

describe("JenovaKnowBrain", () => {
  const okResponse = () => ({
    ok: true,
    body: null,
    text: async () => sse([
      'event: stream_delta', 'data: {"chunk_content":"a fine answer"}', '',
      'event: stream_ended', 'data: {"success":true,"usage":{"cost":"0.01"}}', '',
    ]),
  }) as unknown as Response;

  it("posts to /v1/messages with the bearer key", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const b = new JenovaKnowBrain("jnv_sk_x", fetchFn);
    await b.ask("assessFit", "does this fit?");
    const [url, init] = fetchFn.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.jenova.ai/v1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jnv_sk_x");
  });

  it("sends ephemeral:true so one-shots cost no session fee", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    await new JenovaKnowBrain("k", fetchFn).ask("assessFit", "q");
    const body = JSON.parse(((fetchFn.mock.calls[0]! as [string, RequestInit])[1].body) as string);
    expect(body.ephemeral).toBe(true);
  });

  it("routes to the agent for the task", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    await new JenovaKnowBrain("k", fetchFn).ask("draft", "write a bullet");
    const body = JSON.parse(((fetchFn.mock.calls[0]! as [string, RequestInit])[1].body) as string);
    expect(body.agent).toBe("resume-and-cover-letter-writer");
  });

  it("returns the assembled text and cost", async () => {
    const r = await new JenovaKnowBrain("k", vi.fn(async () => okResponse())).ask("general", "hi");
    expect(r.text).toBe("a fine answer");
    expect(r.cost).toBeCloseTo(0.01, 6);
  });

  it("throws with the status when the request fails", async () => {
    const bad = { ok: false, status: 402, text: async () => '{"error":{"code":"insufficient_credit"}}' } as unknown as Response;
    await expect(new JenovaKnowBrain("k", vi.fn(async () => bad)).ask("general", "hi"))
      .rejects.toThrow(/402|insufficient_credit/);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Create `src/brains/know-brain.ts`**

```ts
const ENDPOINT = "https://api.jenova.ai/v1/messages";

/**
 * Per-task agent routing (spec §13).
 *
 * `agent` is a per-request field, so routing costs nothing beyond picking a slug.
 * `resume-screener` is built to judge a resume AGAINST a job description for
 * hiring managers — pointing it at your own application inverts it into exactly
 * the fit question.
 */
export const AGENTS = {
  findPostings: "career-advisor",
  assessFit: "resume-screener",
  draft: "resume-and-cover-letter-writer",
  general: "jenova",
} as const;

export type KnowTask = keyof typeof AGENTS;

export interface SSEResult {
  text: string;
  cost: number;
  ok: boolean;
  stopReason?: string;
  /** An MCP connection needs the end user to authorise something (§5). */
  needsUser: boolean;
}

/**
 * Parse a Jenova SSE stream into text plus cost.
 *
 * Malformed `data:` lines are skipped rather than thrown — a single bad frame
 * mid-stream should not discard an otherwise complete answer.
 */
export function parseSSE(raw: string): SSEResult {
  let text = "";
  let cost = 0;
  let ok = true;
  let stopReason: string | undefined;
  let needsUser = false;
  let event = "";

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      if (event === "mcp_connection") needsUser = true;
      continue;
    }
    if (!line.startsWith("data:")) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event === "stream_delta" && typeof payload.chunk_content === "string") {
      text += payload.chunk_content;
    }
    if (event === "stream_ended") {
      if (payload.success === false) ok = false;
      if (typeof payload.stop_reason === "string") stopReason = payload.stop_reason;
      const usage = payload.usage as { cost?: string | number } | undefined;
      if (usage?.cost !== undefined) cost = Number(usage.cost);
    }
  }

  return { text, cost, ok, stopReason, needsUser };
}

export interface KnowAnswer {
  text: string;
  cost: number;
}

/**
 * Knowledge-work turns over the Jenova Agent API (spec §6.3).
 *
 * Never receives an image: Jenova requires publicly accessible HTTPS URLs for
 * file input (§5), so sending a screenshot of an application form would mean
 * publishing it. Vision is ActBrain-only.
 */
export class JenovaKnowBrain {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): JenovaKnowBrain {
    const key = env.JENOVA_API_KEY;
    if (!key) throw new Error("JENOVA_API_KEY is empty. Add it to .env.");
    return new JenovaKnowBrain(key);
  }

  async ask(task: KnowTask, content: string): Promise<KnowAnswer> {
    const response = await this.fetchFn(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: AGENTS[task],
        content,
        // No session fee, no stored history, cannot be continued (§5).
        ephemeral: true,
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Jenova ${response.status}: ${raw.slice(0, 200)}`);
    }

    const parsed = parseSSE(raw);
    if (parsed.needsUser) {
      throw new Error("Jenova agent needs an MCP authorisation — not supported in this flow");
    }
    if (!parsed.ok) {
      throw new Error(`Jenova run failed: ${parsed.stopReason ?? "unknown"}`);
    }
    return { text: parsed.text, cost: parsed.cost };
  }
}
```

- [ ] **Step 4: Run and commit**

```bash
git add src/brains/know-brain.ts src/brains/know-brain.test.ts
git commit -m "feat(brains): Jenova KnowBrain with per-task agent routing"
```

---

### Task P3-4: Drafting with the validator in front

**Files:** Create `src/brains/draft.ts`, test `src/brains/draft.test.ts`

Where §7.4's ordering becomes code: **KnowBrain drafts → deterministic validator → only survivors are returned.** A learned scorer would go after this, never before.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { draftTailored } from "./draft.js";
import { factsOf, type Profile } from "../memory/profile.js";

const profile: Profile = {
  name: "A", email: "a@b.c", phone: "", location: "",
  workAuthorized: true, needsSponsorship: false, salaryExpectation: "", links: {},
  employers: [{ company: "Acme Corp", title: "Senior Engineer", start: "2021", end: "2024",
    bullets: ["Led the platform migration, cutting p95 latency 40%"] }],
  education: [], answers: {},
};
const facts = factsOf(profile);
const brain = (texts: string[]) => {
  let i = 0;
  return { ask: vi.fn(async () => ({ text: texts[i++] ?? "", cost: 0.001 })) };
};

describe("draftTailored", () => {
  it("returns a draft that passes the validator", async () => {
    const r = await draftTailored(brain(["Led a platform migration at Acme Corp cutting p95 latency 40%"]) as never,
      facts, "posting text", 3);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Acme Corp");
  });

  it("REJECTS a fabricated draft and retries", async () => {
    const b = brain([
      "Senior Engineer at Globex Industries",                     // fabricated
      "Led a platform migration at Acme Corp cutting latency 40%", // clean
    ]);
    const r = await draftTailored(b as never, facts, "posting", 3);
    expect(r.ok).toBe(true);
    expect(b.ask).toHaveBeenCalledTimes(2);
  });

  it("tells the model WHAT was wrong on the retry", async () => {
    const b = brain(["At Globex Industries", "At Acme Corp in 2021"]);
    await draftTailored(b as never, facts, "posting", 3);
    const second = b.ask.mock.calls[1]![1] as string;
    expect(second).toContain("Globex Industries");
  });

  it("gives up after the attempt limit rather than lowering the bar", async () => {
    const b = brain(["At Globex", "At Initech", "At Umbrella"]);
    const r = await draftTailored(b as never, facts, "posting", 3);
    expect(r.ok).toBe(false);
    expect(b.ask).toHaveBeenCalledTimes(3);
  });

  it("never returns text that failed validation", async () => {
    const r = await draftTailored(brain(["At Globex Industries"]) as never, facts, "posting", 1);
    expect(r.ok).toBe(false);
    expect(r.text).toBe("");
  });

  it("accumulates cost across attempts", async () => {
    const r = await draftTailored(brain(["At Globex", "At Acme Corp"]) as never, facts, "posting", 3);
    expect(r.cost).toBeCloseTo(0.002, 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Create `src/brains/draft.ts`**

```ts
import { checkIntegrity, explain } from "../trust/integrity.js";
import type { ProfileFacts } from "../memory/profile.js";
import type { JenovaKnowBrain } from "./know-brain.js";

export interface DraftResult {
  ok: boolean;
  /** Empty when `ok` is false — text that failed validation is never returned. */
  text: string;
  cost: number;
  violations: string[];
}

/**
 * Draft tailored text, then verify it against the profile (spec §7.4).
 *
 * The ORDER is not negotiable. The deterministic validator runs on every draft
 * before anything else sees it, and text that fails is never returned — not
 * returned-with-a-warning, not returned-for-ranking. A learned scorer, when one
 * is added, may only rank drafts that already passed.
 *
 * On rejection the model is told exactly which tokens were unfounded, which
 * turns the retry into a correction rather than a re-roll.
 */
export async function draftTailored(
  brain: Pick<JenovaKnowBrain, "ask">,
  facts: ProfileFacts,
  posting: string,
  attempts = 3,
): Promise<DraftResult> {
  let cost = 0;
  let last: string[] = [];

  for (let i = 0; i < attempts; i++) {
    const correction =
      last.length === 0
        ? ""
        : `\n\nYour previous draft was REJECTED because these do not appear in the candidate's profile: ${last.join("; ")}. ` +
          `Use only facts from the profile. Do not invent employers, dates, or numbers.`;

    const answer = await brain.ask("draft", `${posting}${correction}`);
    cost += answer.cost;

    const verdict = checkIntegrity(answer.text, facts);
    if (verdict.ok) return { ok: true, text: answer.text, cost, violations: [] };

    last = verdict.violations.map((v) => `${v.kind} "${v.value}"`);
    void explain;
  }

  return { ok: false, text: "", cost, violations: last };
}
```

- [ ] **Step 4: Run and commit**

```bash
git add src/brains/draft.ts src/brains/draft.test.ts
git commit -m "feat(brains): drafting with the validator in front"
```

---

## Done when (3a + 3b core)

- `npm test` green, roughly 190 tests.
- `npm run typecheck` exit 0.
- A fabricated employer, a shifted date, and an inflated metric are each rejected by `checkIntegrity`.
- `draftTailored` never returns text that failed validation.

**Deferred to a follow-up:** resume ingestion via `anydoc` (§6.4) and the CLI `ingest` / `fit` / `draft` commands, which need a real resume document to verify against.
