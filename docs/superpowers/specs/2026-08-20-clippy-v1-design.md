# Clippy v1 — Design Spec

**Date:** 2026-08-20
**Status:** Approved for planning
**Author:** Andes Lee (with Claude)

---

## 1. What this is

A desktop assistant for macOS, shaped like the Office paperclip: a small character that floats
above every window, can be dragged anywhere, and accepts typed instructions. It drives the user's
real browser to complete multi-step tasks on their behalf, pausing for approval before anything
irreversible.

This spec covers **v1 only** — a single-user prototype. Section 4 lists the deferred pillars of the
larger product vision and how v1 prepares for them.

## 2. Goal and success criterion

The prototype exists to answer one question:

> **Can an agent driving a real Mac finish a real task end-to-end without a human rescuing it?**

**Success criterion:** Clippy completes a job application start to finish — find relevant postings,
tailor the resume for each, fill out the application forms — with the user's only interaction being
approval at the Submit gate.

Everything in v1 is scoped to serve that criterion. Features that don't serve it are deferred, not
built "while we're here."

### Audience

Single user (the author), on their own machine, with their own Jenova API key. Consequences:

- Jenova's account rate limits (60 RPM / 1,000 RPD / 5 concurrent) and per-run billing are non-issues.
- No code signing, notarization, auto-update, or installer work.
- The trust layer is real but minimal: a gate, a kill switch, and an audit log. No consent flows,
  no per-user scoping, no privacy policy surface.

## 3. Platform and stack

| Decision | Choice | Rationale |
|---|---|---|
| OS | macOS | Author's machine; only target |
| Runtime | Electron + TypeScript | Transparent always-on-top windows are trivial; CDP is first-class in Node; one language across overlay, orchestrator, and browser control |
| Browser control | Chrome DevTools Protocol against a **dedicated Chrome profile**, logged into job sites only | Job boards sit behind auth, so the profile must be real and logged-in; a clean automated profile hits login walls immediately and trips ATS bot detection. A dedicated profile satisfies that while keeping email and banking out of reach |
| Act-loop model | Claude via `@anthropic-ai/sdk` | Native tool-calling; see §6.3 |
| Knowledge model | Jenova Agent API | Multi-model routing, managed memory, RAG; see §6.3 |

**Rejected:** Tauri (splits the codebase across Rust and TypeScript for a marginal binary-size win)
and native Swift (best OS integration, worst browser tooling — wrong trade for a browser-centric v1).

### 3.1 Blast radius

Any browser Clippy can drive, it can drive anywhere — a CDP connection is not scoped to a domain.
Driving the user's primary profile would therefore put their email and bank one navigation away from
an agent that is still being debugged.

v1 uses a **separate Chrome profile** (`--user-data-dir`), signed into job boards and nothing else.
This costs one round of re-authentication at setup and removes the entire category. The permission
boundary in §7 remains load-bearing regardless, and `hands/` stays the only module permitted to touch
the outside world.

## 4. Non-goals for v1

Each of these is a real part of the product vision, explicitly deferred:

| Deferred | Why | How v1 prepares |
|---|---|---|
| **Ambient desktop observation** ("watch everything I do, continuously") | Highest cost, highest risk. The distillation policy — what to keep, what to discard — can't be designed before we know what's worth keeping | `runs/*.jsonl` becomes the corpus that informs it. Note: **on-demand page comprehension is in v1** — see §8.2 — this row covers only the continuous, whole-desktop version |
| **Vector memory / RAG over user activity** | Nothing to embed yet, and retrieval built before you know what gets retrieved produces the wrong schema | Traces carry structured keys from run one; additive path documented in §10.1 |
| **Native app control** (Word, Finder, Mail) | Requires macOS Accessibility APIs — an entire second control mechanism | `hands/` interface is tool-agnostic; browser is the first implementation, not the only possible one |
| **Auto-created custom agents** | **Blocked externally** — see §5 | `KnowBrain` is the seam this would plug into |
| **Recipes / learned workflows** | Needs run history to learn from | Same JSONL corpus |
| **Packaging, signing, multi-user, billing** | Prototype | — |

**The most valuable output of v1 is not the applications it submits — it is `runs/*.jsonl`,** the
trace of how it succeeded and failed. That corpus is what makes the screen-observation pillar
designable and the recipes pillar possible. It therefore gets designed properly now, even though
nothing reads it yet.

## 5. Jenova platform constraints (researched 2026-08-20)

Findings from `https://www.jenova.ai/platform/docs`, recorded because they shaped the architecture:

| Finding | Consequence |
|---|---|
| **Agents can only be created/edited in the dashboard.** Docs: *"API support for creating and editing agents is coming soon."* | The "creates a custom agent for you if one doesn't exist" feature **cannot be built today.** `GET /agents` lists; nothing provisions. Revisit when the API ships. |
| **No `tools` request parameter and no tool-call response blocks.** Request body is `agent`, `content`, `file_urls`, `user`, `session_name`, `ephemeral`, `stream`, `model`. MCP servers attach to an agent in the dashboard and execute server-side. | Jenova's unit of work is **a finished task, not a next step.** Unusable as the act-loop decision engine without parsing structured data out of prose. |
| **MCP servers are remote and dashboard-configured** | For Jenova to drive the local machine, the machine would need an internet-reachable MCP endpoint. Rejected: unacceptable attack surface, plus tunnel latency on every click. |
| **File input requires publicly accessible HTTPS URLs** (10 files, 20 MB each) | Any image sent to Jenova must first be published to a public URL. This is why **vision is `ActBrain`-only** (§8.2), and it independently disqualifies Jenova from the ambient-observation pillar. |
| Rate limits: 60 RPM, 1,000 RPD, 5 concurrent (per developer account, listed as defaults) | Fine for single-user. Would need renegotiation for any multi-user future. |
| Billing: $0.01 per persistent session, variable per run, $0.50 hold per run | Prefer `ephemeral: true` for one-shot knowledge queries; reserve persistent sessions for multi-turn work. |
| Privacy: API data not used to train Jenova models; commercial channels/opt-outs with third-party providers; US infrastructure | Acceptable for the knowledge-work turns. Reinforces keeping raw activity data local. |

## 6. Architecture

### 6.1 Modules

Six modules, each with one purpose and a defined interface.

| Module | Owns | Interface |
|---|---|---|
| `shell/` | The floating Clippy: sprite + state machine, command input, gate dialog, activity log, panic hotkey | Emits `TaskRequest`; consumes `AgentEvent[]` |
| `orchestrator/` | The run: plan, act loop, budgets, step history | `run(task: TaskRequest): AsyncIterable<AgentEvent>` |
| `brains/` | Model backends behind one interface | `ActBrain.decide()` / `KnowBrain.ask()` |
| `hands/` | The **only** module that touches the outside world: browser, files, resume generation | Each tool statically declares `{ reversible, outwardFacing }` |
| `memory/` | `profile.json` (curated user facts) + `runs/*.jsonl` (append-only trace) | Read / append only |
| `trust/` | Gate policy, kill switch, audit log | `isGated(action): boolean` |

### 6.2 Data flow — one job application

```
user types goal → orchestrator creates Run
  ├─ KnowBrain (Jenova) ──── "postings matching this profile?" → Objective[]
  └─ per Objective:
       ├─ hands.browser.navigate + readPage       (~2KB accessibility tree)
       ├─ KnowBrain (Jenova) ── "fit? draft tailored bullets from profile.json"
       ├─ hands.resume.generate → acme-tailored.docx
       ├─ act loop ─ ActBrain.decide(tree, goal, history) → hands.browser.act
       ├─ Submit → trust gate → shell renders provenance diff → user approves
       └─ append to runs/
```

### 6.3 Two brains, split by unit of work

`brains/` exposes one interface with two implementations, chosen per turn:

**`ActBrain`** — the hot path. `decide(observation, objective, history) → Action`. High volume
(~40 calls per objective), latency-sensitive, simple decisions.

- Claude via `@anthropic-ai/sdk`, model `claude-opus-5`.
- `thinking: { type: "adaptive" }` with `output_config: { effort: "low" }`. Low effort is the
  documented recommendation for high-volume simple decisions: fewer, more-consolidated tool calls
  and less preamble. If latency or cost proves unacceptable in practice, dialling the model down is
  a deliberate follow-up decision, not a default.
- Implemented with the SDK's **Tool Runner** (`client.beta.messages.toolRunner` + `betaZodTool`),
  not a hand-written loop. Its per-turn hooks are exactly the interception point the trust gate
  needs — see §7.
- Prompt caching (`cache_control`) on the stable prefix (system prompt + tool definitions), since
  those bytes are resent on every one of the ~40 turns.
- **The only vision-capable brain.** Screenshots from `capturePage()` (§8.2) arrive here as native
  image content blocks and go nowhere else.

**`KnowBrain`** — task-shaped turns. `ask(question, context) → Answer`. Low volume, latency-tolerant,
genuine judgment.

- Jenova Agent API: `POST /v1/messages`, SSE streaming, bearer `jnv_sk_*`.
- `ephemeral: true` for one-shot queries (no session fee, no stored history); persistent sessions
  only for genuinely multi-turn work.
- Used for: finding and ranking postings, assessing fit, drafting tailored resume bullets and
  free-text answers, and replanning.

Both sit behind one interface so either is swappable and both are mockable in tests.

## 7. Trust model

### 7.1 Gating is mechanical, not prompted

Every tool in `hands/` statically declares `{ reversible: boolean, outwardFacing: boolean }`.
`trust.isGated(action)` is a pure function over those flags. The model is never asked whether it
should confirm — a model that is confused, wrong, or prompt-injected by page content must still be
structurally unable to reach Submit without a human click.

Prompt instructions are advisory. A flag on the tool definition is not.

The Tool Runner's per-turn hook is where this is enforced: the hook inspects the pending tool call,
consults `trust.isGated()`, and blocks on `shell.requestApproval()` before the call executes.

**`trust.isGated()` is to be written by the project author.** It is a short pure predicate encoding
a personal judgment about acceptable irreversibility. The surrounding types, call sites, and tests
will be scaffolded for it.

### 7.2 Kill switch

**⌥⇧Esc**, global, works when Clippy is unfocused and works mid-gate. Aborts the run, releases the
browser, writes the abort to the audit log.

### 7.3 Audit log

Every action, model call, and cost is written **before** the action executes, not after. A crash
mid-action must leave evidence that the action was attempted.

### 7.4 Resume integrity

`KnowBrain` receives `profile.json` as the **only** permitted source of factual claims. Generated
text is validated before reaching any document or form field: every company name, job title, and
date appearing in output must exist in `profile.json`. **Fails closed.**

This is a validator, not a prompt instruction — same reasoning as §7.1. A shopping agent that
hallucinates buys the wrong blender; a job agent that hallucinates puts a fabricated employer on a
real application sent to a real company under the user's name.

### 7.5 Never attempted

CAPTCHAs are never solved or attempted. Encountering one is an immediate STUCK (§8.4). Credentials
are never typed by Clippy — login walls are also an immediate STUCK, resolved by the user typing
their own password into their own browser during takeover.

## 8. The agent loop

### 8.1 Two levels

A flat loop of 200 steps fails for two reasons: the model's judgment degrades as it reasons over
dozens of stale page snapshots, and there is no checkpoint to recover to when step 200 fails.

**Outer loop — the plan.** `KnowBrain` turns the goal into `Objective[]` (*"apply to posting #3 at
Acme"*). Objectives are checkpoints with independent budgets, histories, and outcomes. Objective 3
failing does not cost objectives 4 and 5.

**Inner loop — the act loop.** Per objective:

```ts
while (steps < objective.maxSteps && cost < objective.maxCost) {
  const obs = await hands.browser.readPage();
  if (await objectiveComplete(obs)) break;
  const action = await brains.act.decide({ obs, objective, history });
  if (trust.isGated(action)) await shell.requestApproval(action);
  const result = await hands.execute(action);
  history.push(digest(obs, action, result));
}
```

Starting budgets: `maxSteps = 40` and `maxCost = $1.50` per objective, with a global run ceiling of
$10.00. These are opening guesses to be re-tuned against real runs; the point is that all three exist
and are enforced from run one. Exceeding any of them yields STUCK, not FAILED (§8.4) — a budget
overrun is a question for the user, not a verdict on the objective.

### 8.2 Observation: two modes

**`readPage()` — the default.** Returns the accessibility tree with stable element refs. Roughly 2 KB
of text versus ~1 MB per image, and the model receives element *identity* rather than pixel
coordinates that break the moment the page scrolls. Runs on every act-loop step.

**`capturePage()` — on demand.** Returns a full-page screenshot (CDP `Page.captureScreenshot` with
`captureBeyondViewport: true`; downscaled, with a dimension cap for pathologically long pages)
**together with** the tree. For pages the tree describes poorly: visually grouped forms, custom widgets
that serialise as anonymous containers, sections whose labels are images.

Two rules govern it.

**The screenshot is for comprehension; the tree is for actuation.** The model may consult the image to
decide *what* to do, but every action it emits references a `ref_N` — never a pixel coordinate. This
keeps the snapshot-generation defense in §8.4 fully intact: a coordinate click cannot be validated
against a re-render, so a stale one lands somewhere arbitrary and does so silently.

**Vision is `ActBrain`-only.** Claude accepts images as native content blocks. Jenova requires
publicly accessible HTTPS URLs (§5), so sending a screenshot of an application form to `KnowBrain`
would mean publishing it to a public URL. Never done.

**Triggers:** a "Look at this page" button in the panel (§9.3), and `ActBrain` may emit `capturePage`
as an action when the tree comes back uninformative. Same code path. Ungated under §7.1 — read-only
and reversible — which is comfortable precisely because of the dedicated profile in §3.1.

### 8.3 History compaction

`digest()` retains three things per step: the URL, the action taken, and **what changed** as a
result. The full tree exists only for the current step and is discarded afterward.

This is simultaneously the largest cost lever (the difference between ~2 KB and ~80 KB of input per
decision by mid-task) and the largest quality lever — a model reading a clean twelve-line action
history reasons materially better than one wading through forty DOM dumps.

Screenshots obey a stricter rule: **a screenshot exists only in the turn that consumes it** and is
evicted from history immediately afterward. Two accumulated screenshots would outweigh the entire
remaining context of a 40-step run.

### 8.4 Staleness and failure handling

**Staleness.** Refs describe one snapshot. On a React-based ATS the page can re-render between
`decide()` and `execute()`, leaving `ref_12` pointing at a different element. Two defenses:

1. Every ref carries a **snapshot generation number**; `hands` rejects any action whose generation is
   stale rather than executing it against the wrong element.
2. After each action, wait for network-idle *and* DOM-stable before the next `readPage()`.

**Failure taxonomy.** Different failures require different responses; collapsing them into one
`catch` is how agents get stuck in loops.

| Failure | Response |
|---|---|
| Stale ref | Re-observe, retry same intent — free, does not count against budget |
| Element not found (hallucinated ref) | Re-observe, retry, max 2 |
| Action executed, page unchanged | Retry once, then escalate |
| Navigation timeout | Backoff, retry 2× |
| Model output unparseable | Retry with parse error appended, max 2 |
| Login wall | → STUCK immediately |
| CAPTCHA | → STUCK immediately; never attempted |
| No actionable tree (canvas form, embedded PDF, form-as-image) | → STUCK immediately. `capturePage()` can see it, but nothing is addressable by ref, and coordinate clicking is deliberately not implemented (§8.2). Logged to `runs/` with the domain so the real frequency becomes measurable |

**STUCK ≠ FAILED.** FAILED means *"this objective is unachievable, move on."* STUCK means *"I need
you."* On STUCK, Clippy freezes the browser exactly where it is, enters the `stuck` state, and offers
three choices: **take over**, **skip objective**, **abort run**.

*Take over* is the important one. The browser already sits on the login page; the user types their
password, clicks hand-back, and the run resumes from the current observation. This converts the most
common failure mode in this domain from a dead run into a few seconds of interruption — and it is the
correct place for credentials to be entered: by the user, in their own browser, never through the agent.

### 8.5 Human-takeover detection

During a run, Clippy is driving the user's real Chrome. If the user clicks in the driven tab, they
and the agent are fighting over one browser and the agent's next action lands somewhere unexpected.
The browser layer watches for human input events on the driven tab and **auto-pauses the run**; the
clip enters `blocked` and the panel reports that the user took over.

### 8.6 Replanning

After any objective that ends non-normally, one `KnowBrain` call checks whether the remaining plan is
still valid (posting pulled, approved edit changed fit). Skipped entirely when objectives complete
cleanly.

## 9. Shell

### 9.1 Form factor

**Character plus docked panel.** The clip floats free and is draggable; during a run a panel slides
out from it showing the live step list and any gate. It auto-hides when idle.

Chosen over a speech bubble because the form factor should be decided by the **densest thing the UI
must ever show** — the Submit gate's provenance diff — and let the idle state be what collapses
gracefully. A bubble cannot grow; a panel can hide.

### 9.2 Character states

| State | Appearance | Trigger |
|---|---|---|
| `idle` | Small, still, occasional blink | Default |
| `listening` | Input expanded and focused | Click, or ⌥Space |
| `thinking` | Subtle pulse | `KnowBrain` call in flight |
| `acting` | Panel out, step counter ticking | Act loop running |
| `blocked` | Amber, panel out, gate dialog, single bounce | Gate hit, or human takeover detected |
| `stuck` | Amber, repeating bounce, optional sound | STUCK — user may have walked away |
| `done` | Brief flourish, collapse to `idle` | Run complete |

Only `blocked` and `stuck` compete for attention, and only `stuck` repeats: a gate means the user is
probably present, while stuck means the run has been frozen for an unknown duration.

### 9.3 Interaction

- **Click clip** → input expands. **⌥Space** → summon and focus from anywhere.
- **Drag** anywhere on the clip; position persists across launches.
- **"Look at this page"** button in the panel → forces `capturePage()` (§8.2) on the current page and
  feeds screenshot plus tree into the next `ActBrain` decision. Available whenever a run is active;
  the manual escape hatch for when Clippy is visibly misreading a form.
- **⌥⇧Esc** → panic abort (§7.2).

### 9.4 Click-through

An always-on-top Electron window is a rectangle; a paperclip is not. Untreated, Clippy silently
swallows every click in the transparent box around it, which the user experiences as their desktop
intermittently not responding — and which raises no error.

Implementation: `setIgnoreMouseEvents(true, { forward: true })` by default, with per-pixel hit-testing
on `mousemove` flipping it to `false` when the cursor is over actual paperclip pixels.

### 9.5 The Submit gate

The gate groups by **provenance**, not by form structure:

- **⚠ Generated by Clippy** — expanded by default. Every field whose value came from a `KnowBrain`
  call: rewritten resume bullets, free-text answers. Each shows the integrity validator's result
  (§7.4).
- **✓ Copied from your profile** — collapsed to a single line with a count. Values taken verbatim
  from `profile.json`.
- **Attachments** — generated documents, with preview.

Grouping by provenance puts review effort where the risk is. A wrong email address is a typo; a wrong
resume bullet is a false claim on a real application. It also keeps the gate honest over time — an
18-row undifferentiated list gets rubber-stamped by the fourth application.

The distinction is free architecturally: `hands/` already knows whether a value came from
`profile.json` or from a `KnowBrain` call, because those are different code paths.

**Edit** allows inline correction of generated text. Editing re-runs the integrity validator and
**promotes the value's provenance from generated to human-authored**, so it renders as user-authored
on the next pass. This is preferred to handing the browser back, which is heavier and would leave the
field incorrectly flagged as generated.

## 10. Memory

v1 memory is deliberately minimal. **No vector database** — there is nothing yet worth embedding, and
building retrieval before knowing what gets retrieved produces the wrong schema.

**`profile.json`** — hand-curated. Resume facts (employers, titles, dates, bullet source material),
contact details, work authorization, salary expectations, standard application answers. The single
source of factual truth for §7.4.

**`runs/*.jsonl`** — append-only, one file per run. Each line records a step: observation digest,
action, provenance, result, cost, timestamp. Gates and their outcomes are recorded, as are aborts.

Each step also carries **structured keys** — `domain`, `ats` (greenhouse / workday / lever / other),
`section` (contact / work_history / eeo / questions / upload), and `outcome`. These are cheap to
capture during a run and impossible to reconstruct afterward, which is the whole reason §10.1 works.

Both are gitignored. `runs/` is the seed corpus for the deferred pillars (§4).

### 10.1 Path to retrieval

Deferring the vector database costs nothing because the storage path is additive, not a rewrite:

```
runs/*.jsonl  →  SQLite (relational)  →  + sqlite-vec (vectors, same file)
```

Adding `sqlite-vec` later is a virtual table inside the database that already holds the metadata.
No second store, no synchronisation, no migration.

**Engine: `sqlite-vec`.** Embedded, in-process, one file, MIT-licensed, reachable through
`better-sqlite3`; comfortable to roughly 1M vectors. Chosen over LanceDB (heavier native dependency;
its advantages only appear well above the scale v1 can reach), over Chroma / Qdrant / Weaviate /
pgvector (server-based — wrong shape for a local-first desktop app), and over hnswlib-node / faiss-node
(an index, not a database: no metadata, no join, so the surrounding store gets hand-built).

**Most retrieval here is not semantic.** The unit worth recalling is a *procedure* — "how did a
Workday work-history section go last time" — and that is found by structured key, not by cosine
similarity:

```sql
WHERE ats = 'workday' AND section = 'work_history' AND outcome = 'success'
```

Plain SQL over the keys above answers the common case. Vector search is the fallback for queries that
cannot be written as a `WHERE` clause.

**Grain: segment, not step or run.** Step-level embeddings are useless ("you clicked a button");
run-level are too coarse ("you applied to Acme"). The useful unit is one coherent sub-procedure with
its structured keys and outcome attached. Segments are derived from `runs/*.jsonl` at ingestion time,
which is why the keys must be captured during the run.

**Embedding model: local**, via `transformers.js` (`bge-small-en` or `all-MiniLM-L6-v2`), in-process,
no network. A product premised on observing the user's screen should not ship that content to an
embeddings API. Embedding happens once on write, so local speed is irrelevant. Note that the Claude
API documents no embeddings endpoint — do not plan around one without verifying.

**Trigger to build it:** the first time a wanted retrieval cannot be expressed as a `WHERE` clause.
Not a run count, not a corpus size — that specific moment. Expect it to arrive with screen
observation rather than with job applications, since applications have clean structured keys and
general screen activity does not.

## 11. Testing strategy

The module boundaries in §6.1 were chosen largely to make this possible.

| Layer | Approach |
|---|---|
| `orchestrator/` | `brains/` mocked; scripted decisions, zero network. Every branch of the failure taxonomy (§8.4) becomes a deterministic unit test |
| `hands/browser` | Real Greenhouse / Workday / Lever pages captured to disk once as **tree + screenshot pairs**, then replayed. Tests the tree reader, ref-generation, and `capturePage()` framing without network calls or burning real applications |
| `trust.isGated()` | Pure function, exhaustively unit tested. **100% branch coverage** — this is the safety boundary |
| §7.4 validator | Pure function; table-driven tests including adversarial cases (invented employer, shifted date, plausible-but-absent title) |
| End-to-end | One recorded posting replayed as a smoke test |

## 12. Risks

| Risk | Mitigation |
|---|---|
| ATS bot detection blocks automation despite the real profile | Human-paced actions; STUCK on detection rather than evasion. If systemic, it invalidates the task choice — discover this early |
| Act loop can't reliably complete a 40-step form | This is the question v1 exists to answer. A negative result is a valid outcome |
| Cost per application exceeds usefulness | Compaction (§8.3) and caching (§6.3) are the levers; measure from run one |
| `capturePage()` overused, blowing the per-objective budget | Screenshots are evicted from history after one turn (§8.3) and downscaled before send. If `ActBrain` reaches for it every step, that is a prompting problem — cap auto-triggered captures per objective and surface the count in the panel |
| Jenova latency on knowledge turns makes runs feel slow | Knowledge turns are off the hot path; overlap them with browser work where possible |
| Submitting a bad application to a real employer | §7.1 gate, §7.4 validator, §9.5 provenance diff. Three independent layers |

## 13. Resolved at implementation time

One item cannot be settled from documentation alone:

- **Jenova agent slug.** `KnowBrain` must target a specific `agent` value. The default is the
  general-purpose `jenova` agent; if `GET /agents` against a live key reveals a better-suited
  pre-built agent, use that instead. Resolve before the first `KnowBrain` call is written. If Jenova
  ships the agent-creation API (§5), a purpose-built agent with `profile.json` as a knowledge base
  becomes the better option.

Everything else in this spec is decided.
