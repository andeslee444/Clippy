# Tree Quality Findings — Plan 1, Task 11

**Date:** 2026-08-21
**Method:** Live CDP session against a dedicated Chrome profile (port 9333), running the real `readPage()` against real ATS pages. Not fixtures.

---

## Verdict

**Sufficient — proceed to Plan 2.** The accessibility tree that real ATS platforms produce is good enough to act on, and §8.2's core assumption holds. One material coverage gap was found and is now surfaced rather than hidden.

---

## What was tested

| Platform | Page | Result |
|---|---|---|
| **Greenhouse** | `job-boards.greenhouse.io/anthropic/jobs/5023394008` — a real application form | 42 nodes, 1 unnamed, 1 submit-capable |
| **Greenhouse** | `job-boards.greenhouse.io/anthropic` — board listing | 65 nodes, 1 unnamed |
| **Workday** | `nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite` — React SPA | 46 nodes, 1 unnamed, **0 `<form>` elements** |

Lever was not reachable at the URL tried (404); it is the least common of the three and does not change the verdict.

## 1. Coverage — good

Every field a human must fill appears in the tree, correctly named:

```
g1-r26  textbox   "First Name*"
g1-r27  textbox   "Last Name*"
g1-r28  textbox   "Email*"
g1-r29  combobox  "Country"
g1-r31  textbox   "Phone"
g1-r33  file      "Attach"
g1-r37  combobox  "Please note that you will not be considered unless you complete the Constellation applica…"
g1-r40  button    "Submit application"                                    <<SUBMIT
```

The `*` suffix survives, so required fields are distinguishable. The one unnamed node on each page is the site logo link — harmless.

## 2. Naming — two defects found and fixed

**The 80-character cap truncated meaningful content.** Greenhouse renders required questions *as the field label*, and `g1-r37`'s real question was cut to `"...unless you comple…"`. A model reading that cannot know what is being asked, and would either guess or go STUCK for the wrong reason. Fixed: caps are now per-role — links keep 80 (job descriptions are full of them and 80 identifies one fine), form controls get 240.

**`textContent` ran adjacent block elements together.** A listing entry came back as `"Anthropic Fellows ProgramLondon, UK; Ontario, CAN"` — no separator between title and location. Fixed by preferring `innerText`, which respects layout; `sanitize()` then collapses the resulting breaks to spaces. Falls back to `textContent` under linkedom in tests.

## 3. Actionability — good, with one real gap

`submitCapable` correctly identified exactly one element on the Greenhouse form — `"Submit application"` — and nothing else. That is the safety property working on a real page.

**But Workday has zero `<form>` elements.** It is a SPA driving everything through click handlers, so `closest("form")` returns null for every element and **nothing is flagged**. On a Workday application, a `click` on the real submit button would not be refused and would not gate.

Two things were ruled out while investigating:

- **Form method is not a usable signal.** The obvious refinement — treat `method="get"` forms as harmless searches and `method="post"` as real submissions — is actively dangerous. Greenhouse's *application form* declares `method="get"` and submits over XHR. That heuristic would have classified the real Submit button as safe.
- **`Browser.getBrowserCommandLine` is not usable for profile verification.** It refuses unless Chrome is launched with `--enable-automation`, which sets `navigator.webdriver` and shows the automation infobar — the exact bot-detection signals that using a real logged-in profile exists to avoid (§3.1). Replaced with an OS-level check (`lsof` for the process holding the port, `ps` for its `--user-data-dir`), verified in both directions against live Chrome.

**Mitigation shipped:** `Snapshot.formless` is true when the page contains no `<form>`. The gap is now visible to the gate policy rather than silently absent. `isGated` can require approval for every click on a formless page — trading friction on Workday for the guarantee holding everywhere.

## 4. Custom widgets — usable, slightly noisy

Greenhouse's file attach renders as four nodes (`button "Attach"`, `file "Attach"`, `button "Dropbox"`, `button "Google Drive"`) plus `button "Enter manually"`. The `file` role is the actionable one and is correctly identified. Comboboxes appear as `combobox` plus a `button "Toggle flyout"` sibling — workable, mildly redundant.

## 5. Noise — acceptable, worth watching

25 of 42 nodes on the Greenhouse application page are links from the job description prose. That is ~60% of the tree carrying no actionable value, inflating both cost and the amount the model must reason past. Not blocking — links are trivially skippable by role — but if per-application cost runs high in Plan 2, filtering description-region links is the first lever to pull.

## Consequences for Plan 2

1. **`isGated` should account for `formless`.** On a page with no forms, element-derived submit detection is unavailable, and the honest response is to gate more, not to assume safety.
2. **Workday needs a second look before it is claimed as supported.** Greenhouse is genuinely covered; Workday's protection currently rests on the model correctly labelling its own action, which §7.1 says is not a guarantee.
3. **Refs are process-unique.** The generation now seeds from `Date.now()`, so a ref recorded by one process cannot resolve against a different element in the next — visible as `g1787290894-r37` in live output.
4. **Budget from measured numbers.** A real application page is ~42 nodes / ~2 KB rendered, which matches §8.2's estimate and confirms the compaction budget in §8.3 is realistic.
