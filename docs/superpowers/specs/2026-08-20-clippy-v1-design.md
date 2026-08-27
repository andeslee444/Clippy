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
| Document reading | `@firecrawl/anydoc` | Rust, in-process, no network; prebuilt `darwin-arm64` Node binding. See §6.4 |

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
| **Bullet-quality scoring** (`llm-as-a-verifier`, best-of-N over drafted variants) | Unknown whether bullet quality is actually a problem. Costs a Python subprocess boundary, a third vendor for logprobs (`DEEPSEEK_API_KEY`, `deepseek-v4-flash` backend), and 3× drafting spend | §7.4 fixes the ordering it must slot into. **Trigger:** tailored bullets read as consistently mediocre across several applications in the §9.5 gate |
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
- **`agent` is chosen per task, not per application.** It is a per-request field, so routing costs
  nothing beyond picking a slug. See §13 for the mapping.

Both sit behind one interface so either is swappable and both are mockable in tests.

### 6.4 Document I/O

Reading documents and writing them are separate problems with separate tools. Conflating them
produces a tailored resume that an ATS parses as one run-on field.

**Read — `@firecrawl/anydoc`.** Converts DOCX, PDF, PPTX, XLSX, ODF, RTF, EPUB, and CSV into a
structured document model. Rust with a prebuilt `darwin-arm64` Node binding, in-process, no network,
single-digit milliseconds.

Use `toDocument()` rather than `toMarkdown()`: it returns the block model with headings, lists, and
tables intact, which parses into employers / titles / dates far more reliably than re-parsing Markdown
that has already flattened the structure.

Consumers: populating `profile.json` from the user's real resume (§10), and job descriptions that
arrive as PDF attachments rather than HTML.

**Write — template surgery, not generation.** anydoc is one-way (`src/render/` targets Markdown only),
and that is the correct constraint. The tailored resume must **not** be generated as a fresh document:

- ATS parsers are brittle about column layouts, headers, and text boxes. A regenerated file can be
  silently mangled into unusable garbage at the exact moment it matters.
- Recruiters see formatting before they read a word, and the user's existing layout is a deliberate
  artifact.

Instead, the user's real `.docx` is the template and generation is **targeted text replacement in the
OOXML** (docxtemplater, or direct XML manipulation), preserving every style. Only the text spans
identified as tailorable change; everything else is byte-identical.

### 6.5 Wiring must be forced by types, not remembered

**Added 2026-08-27, after the same defect appeared five times in one build.**

The shape is always identical: a field written by one component, read by another, and populated by
nothing in between at the moment it is read. Neither side is wrong. The wire is missing.

| Instance | Symptom |
|---|---|
| `budget.record()` never called | `maxSteps` unenforced; a run that filled two fields reported "0 steps" |
| `provenance` never stamped | The §9.5 gate consumed a field nothing wrote — every value showed `unknown` |
| `Objective.readOnly` dropped | The eval harness rebuilt the objective from an explicit field list, silently omitting the flag that makes §7.3 observation-only real |
| `checkIntegrity` never called at the gate | Implemented, tested, and rendered — but the only call sites were the `draft` tool and the edit handler, so a real Submit gate showed 900 words of generated prose with no warnings |
| `resumePath` captured too early | The CLI loads the profile lazily, so a path read at construction was `undefined` for the life of the process; the model reported "no résumé on file" while one sat in the profile |

**None of these was caught by a unit test, and none of them could have been.** A unit test supplies
the input and verifies the function given that input — which is precisely the thing that was never
in question. Every instance was found by reading real output that looked wrong.

Three rules follow, and they are cheap:

1. **Required over optional.** When a component's correctness depends on a value another component
   supplies, the parameter is required. Making `buildGateView`'s facts optional would have
   reproduced its bug exactly: the call site that forgets is the call site that needs it. Made
   required, the compiler asked at all fourteen existing call sites in one build.
2. **Thunk over snapshot.** A value read from mutable state is a function, not a string. A string can
   be captured at the wrong moment; a function cannot. This is what fixed `resumePath`, and the type
   change *is* the fix.
3. **No explicit field lists** where a spread will do. The `readOnly` bug was a literal
   `{goal, maxSteps, maxCost, context}` that predated the flag and silently kept omitting it.

A convention that has to be remembered at every call site is not a design; it is a defect with a
delay on it.

## 7. Trust model

### 7.1 Gating is mechanical, not prompted

Every tool in `hands/` statically declares `{ reversible: boolean, outwardFacing: boolean }`, and
`trust.isGated()` is a pure function over those flags. The model is never asked whether it should
confirm — a model that is confused, wrong, or prompt-injected by page content must still be
structurally unable to reach Submit without a human click.

Prompt instructions are advisory. A flag on the tool definition is not.

#### The declared kind is not trustworthy

A first version of this design gated on the action's *kind*: `submit` was flagged irreversible and
outward-facing, `click` was not. **That is circular, and it does not work.** `submit` and `click` are
the same operation on the same element; the only thing separating them is the label the model chose
to emit. A model that emits `{kind: "click", ref: <the Submit button>}` gets an ungated click on
Submit and an audit line reading `"gated": false`. The gate would be keying off model-supplied data —
exactly as advisory as the prompt instruction it claims to replace.

Page content makes this reachable rather than merely theoretical: accessible names are attacker-
controlled text, so a crafted `aria-label` containing a newline can forge an extra line in the
rendered tree and tell the model that the Submit button is named "Cancel".

**Gating therefore keys off the resolved element, not the declared kind.** Concretely:

1. `hands/` resolves the ref to a real element and derives `{ submitCapable, formAssociated }` from
   the DOM — `input[type=submit|image]`, a `<button>` inside a form without `type="button"`, or a
   `role=button` whose activation submits.
2. The gate is re-evaluated **after** resolution, against the element's derived properties unioned
   with the tool's static flags.
3. A `click` on a submit-capable control is **refused**, not silently upgraded. The model must
   name it `submit`, which gates. Refusal is louder than coercion and shows up in the audit log.
4. Accessible names are sanitised before rendering: whitespace collapsed on every path, quotes
   escaped, length capped. Page text can never introduce a line break into the tree.

The static `TOOL_META` table remains the floor, not the ceiling — element-derived properties can
only ever *add* gating, never remove it.

**The author's decision lives in two places**, and the table is the more consequential one:
`TOOL_META` (is `upload` really reversible? is `navigate` outward-facing?) and the `isGated()`
predicate combining static flags with element-derived properties.

#### Prefer a capability the model cannot misdirect

Gating decides whether an action needs a human. A prior question is what the action can express at
all, and the cheapest safety property is the one that is unrepresentable rather than merely refused.

`upload` takes a filesystem path. Exposed to the model directly, that path is model-controlled text
sitting one persuasive page away from `~/.ssh/id_rsa` — and F4 (§11) exists because pages do try
exactly that. The allowlist in `trust/uploads.ts` refuses it, and the schema refuses it again before
anything touches the disk, but both are checks on a bad request that was allowed to be formed.

The tool the model actually gets is **`attach_resume(ref)`**, which takes no path. The file comes
from the loaded profile. The model decides *whether* to attach and *where* — never *what*. The
allowlist stays, because defence in depth is not redundancy when the thing being defended is a
private key, but it is now the second line rather than the only one.

Generalised: **when a capability needs one argument from the user's world and one from the model's,
do not let the model supply the first.**

### 7.2 Kill switch

**⌥⇧Esc**, global, works when Clippy is unfocused and works mid-gate. Aborts the run, releases the
browser, writes the abort to the audit log.

### 7.3 Audit log

Every action, model call, and cost is written **before** the action executes, not after. A crash
mid-action must leave evidence that the action was attempted.

#### Effects and observations are different types

`Effect`s change the world and return nothing (`click`, `fill`, `select`, `upload`, `navigate`,
`submit`). `Observation`s change nothing and return data (`readPage`, `capturePage`). Modelling them
as one union forces the executor to `Promise<void>`, which means observations cannot flow through it
and get called directly instead — so nothing observed is ever audited, contradicting the paragraph
above.

They are therefore separate types with separate paths: `runEffect(e): Promise<void>` gates and
audits; `observe<T>(o): Promise<T>` audits and returns. Both are audited. Only effects can gate,
because only effects can be irreversible.

### 7.4 Resume integrity

`KnowBrain` receives `profile.json` as the **only** permitted source of factual claims. Generated
text is validated before reaching any document or form field: every company name, job title, and
date appearing in output must exist in `profile.json`. **Fails closed.**

This is a validator, not a prompt instruction — same reasoning as §7.1. A shopping agent that
hallucinates buys the wrong blender; a job agent that hallucinates puts a fabricated employer on a
real application sent to a real company under the user's name.

**Truth and quality are different questions.** This validator answers *"did it invent a fact?"* — a
factual question with a right answer, checkable by string match, that fails closed. It does not answer
*"is this bullet any good?"* — a judgment with no ground truth.

Bullet quality is addressed by a deferred component (§4): `llm-as-a-verifier` doing best-of-N selection
over drafted variants. The **ordering is not negotiable when it lands**:

```
KnowBrain drafts N variants
      ↓
§7.4 deterministic validator     ← hard gate, fails closed
      ↓
verifier.select(criteria=…)      ← ranks only what already passed
      ↓
best surviving variant
```

A learned scorer must never be the safety gate. Run the other way round — verifier first, filtering to
"the best one" — a fabricated bullet that happens to score well passes straight through, and a
guarantee has been traded for a probability.

#### The check must run where the human is looking

**Added 2026-08-27.** A validator that is not invoked at the decision point is documentation.

`checkIntegrity` had two call sites: the `draft` tool, and the handler that runs when a person edits
a value in the gate. A real application to a real posting reached the Submit gate having used
`fill` — the ordinary path — so the check never ran. The gate displayed 900 words of generated prose
with no warnings, not because it passed but because nobody asked. The renderer even had a warning
line ready and left it hidden until someone edited the field, which means the one reader who never
edits anything, the one clicking Approve, saw nothing.

**§7.4 runs when the gate is built**, on values the model produced. Profile and human values are not
checked: a profile value failing §7.4 means the profile disagrees with itself, which is a real
problem but not one to raise over a Submit button. Values under 40 characters are skipped, because a
one-word answer has no room for a fabricated claim and running an entity tokenizer over `"Yes"`
produces noise that trains the reader to skip the warnings that matter.

#### Narrowing the tokenizer is not loosening the check

The first honest measurement of this validator, against a truthful answer, was **eight violations
and zero fabrications**. Every one was an artifact of how prose was cut into candidate entities:

| Reported | Actually |
|---|---|
| `Nasdaq's` | possessive not stripped before lookup |
| `Bloomberg I` | the English pronoun swallowed by the capital run |
| `SQL. I` | the run carried past a full stop into the next sentence |
| `On NMC's` | a capitalised leading preposition landed inside the name |
| `(a) Deal` | a list marker not recognised as opening a clause |
| `TradingView` | the résumé writes it "Trading View" |

This is the failure mode that matters most for a fail-closed check, and it is not a false negative.
**A check that cries wolf eight times per real finding has already failed open**, whatever its code
says, because the human stops reading it. The pressure at that point is to relax what counts as a
match — and that is how the guarantee actually dies.

The distinction the fix has to preserve: **normalise the token, never the comparison.** Each variant
of a spelling is tried against the same unchanged sources, so an organisation absent from the
profile, the posting, and the allow-list still fails under every variant. A test pins that a
fabricated employer is still rejected as `Globex`, `Globex's`, `At Globex I`, `(a) At Globex`, and
`GlobexIndustries`.

Stopping is also a design decision. Three warnings remain on that answer — `IB-style`,
`Hands-on AI`, `As Lead PM`, all abbreviations genuinely absent from both sources. Narrowing further
would mean fitting the tokenizer to one answer, and a fail-closed check drifts open one reasonable
accommodation at a time.

#### Three kinds of unverifiable, and only one is a validator problem

**Added 2026-08-27.** F2 sat at 8/10 for the whole build on an answer that was true in every
particular. The three violations were not one problem:

| Flagged | What it really is | Where the fix belongs |
|---|---|---|
| `UT Austin` | An **acronym** of "University of Texas at Austin" | The validator. A résumé writes the short form; nobody writes the long one in prose |
| `nine years` | **Arithmetic**: 2026 minus the profile's 2017 | The prompt |
| `Nasdaq's`, `SQL. I` | **Tokenizer artifacts** | The tokenizer (above) |

The acronym is mechanical and belongs in the validator: every token of the candidate must be
accounted for — present among the organisation's words, or a prefix of its initials — so `GX Austin`
and `MIT Austin` still fail.

The arithmetic is the interesting one, because **the obvious fix is wrong.** Teaching a
string-matching check to do date algebra would trade a guarantee for a heuristic, in the one
component whose value is that it fails closed. The claim is correct and unverifiable *by this
mechanism*, and the honest response is not to weaken the mechanism.

So the model is asked not to produce it: **"since 2017", never "the last nine years."** Better prose
regardless — the reader can do the subtraction, and cannot check the assertion. The prompt states
the consequence rather than the rule, because a model told *why* a constraint exists follows it
better than one handed the constraint:

> A separate check verifies your text against the profile and flags anything it cannot find, and the
> person has to read every flag before they can send the application.

Note the division of labour. The prompt is advisory — §7.1's whole premise — so it is used only where
the failure is *noise a human must read*, never where the failure would be *an unsafe action*. Prompt
for tidiness; mechanism for safety.

#### The second source of truth has to actually be supplied

§7.4 has always specified two sources: `profile.json` for candidate claims, the posting for employer
and role claims — a company's own words for its teams, products, and technologies will never appear
in a candidate's résumé, and rejecting them would make every tailored answer fail.

The gate was passing `""` for the posting. The parameter existed, was documented, and was empty at
the only call site that mattered — §6.5 again. It is now wired from the most recent page read.

### 7.5 Never attempted

CAPTCHAs are never solved or attempted. Encountering one is an immediate STUCK (§8.4). Credentials
are never typed by Clippy — login walls are also an immediate STUCK, resolved by the user typing
their own password into their own browser during takeover.

#### Credentials must be excluded from observation, not just from action

"Clippy never types your password" is insufficient, because the danger is on the read path rather
than the write path. The takeover protocol has the user type their real password into the driven
browser and hand back — and the very next `readPage()` would collect that field's value into the
tree, ship it to the model, and write it into `runs/*.jsonl` forever.

`readPage()` therefore **redacts at the source**, before any value leaves the page:

- `input[type=password]` — value replaced with `"•••"`, never collected
- `autocomplete="cc-*"` (card number, CVC, expiry) — same
- fields whose name or id matches `/ssn|social|passport|tax|routing|account/i` — same

Redaction happens inside the page-side snapshot function, so the plaintext never crosses into Node.
The node itself is still emitted — the model needs to know a password field exists to recognise a
login wall — only the value is withheld.

### 7.6 Effects must prove they landed

**Added 2026-08-27.** An effect that reports success without evidence is worse than one that fails,
because every layer above it — the model, the budget, the audit log, the closing message to the
user — believes it.

Three real failures, each from a different effect:

- **`fill`** returned `ok` having changed nothing. The model re-read the page, saw an empty field,
  filled it again, and burned a 40-step budget on two fields.
- **`select`** succeeded against a react-select widget that keeps its `<input>` empty and renders
  the choice into a sibling `div`. The snapshot showed `""`, so the model re-selected: 27 selects
  across 18 reads. *A tool result that cannot show work being done is as bad as one that lies.*
- **`submit`** returned `ok` on a form that had rejected the submission. The run reported DONE and
  the model told the user it had applied for a job it had not applied for.

**Every effect names its own evidence**, and the evidence is read from the page, never inferred from
the call returning:

| Effect | Landed when |
|---|---|
| `fill` | the field holds the value |
| `select` | the choice is *displayed* — the value may live in a sibling node, not `.value` |
| `upload` | the file input reports a file |
| `submit` | **the page navigated** |

`select` is the subtle one, because the widget can be wrong in three different
places at once. Greenhouse's location field needed all three fixed before a value would land:

- **Type, do not fill.** `fill()` sets the value and dispatches one input event. An async combobox
  starts its debounced search from *keystrokes*, so a filled value leaves the option list empty
  forever — the field offered zero options on every attempt until this changed.
- **Poll for options, do not sleep.** They arrive roughly 700ms after typing and none exist at click
  time. A fixed wait either races the request or pads every synchronous select with dead time.
- **A remote search takes the query literally.** `"New York, NY"` matches nothing in an index that
  spells it `"New York, New York, United States"`, while its first segment returns nine results.
  Retype the shorter query, which is what a person does, and match on the leading segment — with the
  option's own leading segment required to be identical, so `"New York"` cannot quietly settle for
  `"New Rochelle, New York, United States"`.

And the evidence must not be borrowed from the wrong check. `verifyLanded` reads `inputValue`, which
for a combobox holds the text that was *typed* — not a selection. It reported
`select ok: New York, NY` for a field that had chosen nothing, and four consecutive submits were
rejected for a missing location. **A control that can be asked what it displays is asked; one that
cannot is not assumed to have succeeded.**

#### For submit, the direction of the error decides the design

The other effects can be conservative: a false "didn't land" costs a retry. Submit cannot, and the
asymmetry runs the opposite way to intuition.

A false *positive* invents an application that does not exist. A false *negative* reads as "not
sent" — and the obvious, correct-seeming response to "not sent" is to send it again. **The failure
mode of a check meant to prevent a phantom application is duplicate real ones**, arriving under the
user's name at an employer they are trying to impress.

This is not hypothetical. Verification originally read the DOM as soon as `settle()` returned, which
is while the *old* document is still on screen — and the old document still holds the validation
errors from the previous attempt. It reported "Please enter your location" for a submission
Greenhouse had already accepted. The run ended STUCK, the audit log recorded four rejections, and
the confirmation page was loading behind it.

So the order is fixed: **navigation is checked first and is sufficient.** Validation signals
(`aria-invalid`, short visible messages in validation phrasing) are consulted *only* if the page has
not moved. The URL is captured before the click, because after it there is nothing to compare
against.

#### Page-side code may not define named functions

A constraint, not a preference, and it has been violated twice.

`tsx`/`esbuild` compile with `keepNames`, which rewrites `const seen = (e) => …` into
`__name((e) => …, "seen")`. `__name` is a bundler helper that does not exist in the browser, so any
callback passed to `page.evaluate` containing a *named* function throws `ReferenceError` at runtime
while compiling and unit-testing perfectly cleanly. The first occurrence cost the page script, which
now lives as unbundled `.js` loaded as text; the second silently turned every `submit` into a
failure.

Booleans, loops, and anonymous callbacks are fine. Named ones are not. §11 covers why the test suite
cannot see this.

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

Values are redacted at the source before leaving the page — see §7.5.

#### The serialization boundary

The snapshot function runs **inside the page**, not in Node. It therefore cannot reference any
module-scope binding, import, or closure variable — such a reference throws `ReferenceError` in the
browser while passing every direct-call unit test, because Node resolves it via closure.

Two bugs of exactly this shape were shipped and caught during Plan 1: a module-scope `SELECTOR`
constant, and then — after a regression test was added — `__name`, a helper that the production
bundler (`tsx`/esbuild with `keepNames`) injects around named inner functions but the test bundler
does not. The second one is the instructive case: **the transform is part of the boundary**, so a
test that serialises under the test bundler is testing a function that will never run.

The structural fix, rather than a per-instance one: page-side code lives in its own plain
`.js` file that no bundler transforms, loaded as text at runtime. It then physically cannot close
over module scope, and no one has to remember the rule.

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
| Effect reported success, page disagrees | Not a failure *response* — a failure to detect. See §7.6: the effect itself must fail |
| Submit rejected by form validation | Surface the form's own messages to the model and continue; it is recoverable and the form has said exactly what is wrong |
| Custom widget will not accept a value (Places autocomplete, combobox) | Retry via the widget's own interaction, then → STUCK naming the field. Never submit around it |
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

**"Each shows the integrity validator's result" is load-bearing and was, for one whole build, false.**
The warning line existed and stayed hidden until someone edited the field — so the only reader who
never edits anything, the one clicking Approve, saw no warnings at all. The result is now computed
when the gate is *built* (§7.4), not when a field is touched.

The gate must also show **what** is about to be sent, not merely that something is. The CLI gate
printed the effect as JSON — `{"kind":"submit","ref":"g…-r61"}` — which tells the reader a submit is
pending and nothing about the seventeen values riding on it. That is not a decision anyone can
actually make. Both surfaces render the same `buildGateView` output, so the terminal and the panel
cannot drift.

**Edit** allows inline correction of generated text. Editing re-runs the integrity validator and
**promotes the value's provenance from generated to human-authored**, so it renders as user-authored
on the next pass. This is preferred to handing the browser back, which is heavier and would leave the
field incorrectly flagged as generated.

## 10. Memory

v1 memory is deliberately minimal. **No vector database** — there is nothing yet worth embedding, and
building retrieval before knowing what gets retrieved produces the wrong schema.

**`profile.json`** — resume facts (employers, titles, dates, bullet source material), contact details,
work authorization, salary expectations, standard application answers. The single source of factual
truth for §7.4.

Populated by running the user's real resume through `anydoc.toDocument()` (§6.4) and mapping the block
model into fields, then **reviewed and corrected by hand**. Extraction is a starting point, not an
authority: this file is what every factual claim in every application is checked against, so an
extraction error propagates into real submissions. The path to the source document is retained, since
it is also the template for the write path (§6.4).

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
| Document I/O (§6.4) | Extraction tested against a real resume fixture, asserting employers/titles/dates land in the right fields. Template surgery asserts the output opens, and that every span outside the tailored text is byte-identical to the source |
| End-to-end | One recorded posting replayed as a smoke test |

### 11.1 What this strategy structurally cannot catch

**Added 2026-08-27.** Two classes of defect are invisible to every row of the table above, and both
have shipped. Naming them is more useful than pretending more of the same tests would help.

**Missing wiring (§6.5).** A unit test supplies the input and checks the output — verifying the
function *given* its input, which is exactly what was never in doubt. Five defects of this shape
passed a green suite. The mitigation is not a test; it is the type system (required parameters,
thunks over snapshots), plus reading real output and treating anything that looks wrong as wrong.

**Code that runs in the page.** The fake `Page` used by `hands/browser` tests never executes the
callback handed to `page.evaluate` — it returns a canned value. So a callback that throws
`ReferenceError` in a real browser passes every test (§7.6). The mitigation is a **source guard**:
a test that reads `hands/browser/*.ts`, extracts each `evaluate(…)` callback by bracket matching,
and fails if one declares a named function. It is a lint rule wearing a test's clothes, and it
encodes an invariant no behavioural test can reach.

Where a defect class cannot be tested, the honest move is to say so in the spec and put a
structural guard in its place — not to add more tests of the kind that already missed it.

## 12. Risks

| Risk | Mitigation |
|---|---|
| ATS bot detection blocks automation despite the real profile | Human-paced actions; STUCK on detection rather than evasion. If systemic, it invalidates the task choice — discover this early |
| Act loop can't reliably complete a 40-step form | This is the question v1 exists to answer. A negative result is a valid outcome |
| Cost per application exceeds usefulness | Compaction (§8.3) and caching (§6.3) are the levers; measure from run one |
| `capturePage()` overused, blowing the per-objective budget | Screenshots are evicted from history after one turn (§8.3) and downscaled before send. If `ActBrain` reaches for it every step, that is a prompting problem — cap auto-triggered captures per objective and surface the count in the panel |
| Jenova latency on knowledge turns makes runs feel slow | Knowledge turns are off the hot path; overlap them with browser work where possible |
| Submitting a bad application to a real employer | §7.1 gate, §7.4 validator, §9.5 provenance diff. Three independent layers |
| **Submitting the same application twice** | A submit wrongly reported as failed invites a resend (§7.6). Navigation is checked before validation signals, and is sufficient on its own |
| **A safety check that is never invoked** | Every check named in §7 must have a call site on the path a real run takes, not only on the path that motivated it. §7.4's gate wiring was missing for the entire build before it was measured |
| **A fail-closed check ignored because it is noisy** | Measured against real generated text before being trusted; false-positive rate is a safety property, not a polish item (§7.4) |
| A required field no widget interaction can satisfy | → STUCK naming the field (§8.4). Never submit around it, never invent a value |

## 13. KnowBrain agent routing (resolved 2026-08-21)

`GET /v1/agents` against a live key returns **262 pre-built agents**. Since `agent` is a per-request
field, routing per task costs nothing — no extra integration, and with `ephemeral: true` no additional
session fees.

| `KnowBrain` task (§6.2) | Agent slug | Why |
|---|---|---|
| Find and rank postings | `career-advisor` | Career strategist with real-time research |
| Assess fit against a posting | `resume-screener` | Built to evaluate a resume *against* a job description for hiring managers. Pointing it at your own application inverts it into precisely the fit question |
| Draft tailored bullets and free-text answers | `resume-and-cover-letter-writer` | Purpose-built for tailored, ATS-optimised documents |
| Replanning and everything else | `jenova` | General-purpose fallback |

**One risk to instrument from run one.** `resume-and-cover-letter-writer` exists to make an applicant
look good; §7.4 exists to stop that the moment it crosses into invention. The validator fails closed,
so this is a *friction* risk rather than a correctness one — but a high rejection rate means wasted
spend and repeated retries on the slowest path in the system.

Log the validator's rejection rate **per agent** to `runs/` from the first application. If it runs
high, fall back to `jenova` with tightly-scoped instructions, where the framing is ours rather than
the pre-built agent's.

If Jenova ships the agent-creation API (§5), a purpose-built agent carrying `profile.json` as its
knowledge base supersedes this entire table.

Every decision in this spec is now settled.
