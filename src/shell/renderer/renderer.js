// @ts-check
/*
 * The view. It owns no state that matters — the main process holds the browser
 * session, the executor, and the brains. Everything here arrives over IPC.
 */

const clip = /** @type {HTMLElement} */ (document.getElementById("clip"));
const panel = /** @type {HTMLElement} */ (document.getElementById("panel"));
const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const goal = /** @type {HTMLInputElement} */ (document.getElementById("goal"));
const stepsEl = /** @type {HTMLElement} */ (document.getElementById("steps"));
const gate = /** @type {HTMLElement} */ (document.getElementById("gate"));
const gateHead = /** @type {HTMLElement} */ (document.getElementById("gate-head"));
const gateGroups = /** @type {HTMLElement} */ (document.getElementById("gate-groups"));

const STATES = ["idle", "listening", "thinking", "acting", "blocked", "stuck", "done"];

/** Mirrors the window's ignore-mouse state in main. Must be kept in step with it. */
let solid = false;

function setState(state) {
  document.body.classList.remove(...STATES);
  document.body.classList.add(state);
}

/* ── click-through (spec §9.4) ────────────────────────────────────────────────
 * An always-on-top window is a RECTANGLE; a paperclip is not. Untreated, Clippy
 * silently swallows every click in the transparent box around it, which the user
 * experiences as their desktop intermittently not responding — with no error
 * anywhere to explain it.
 *
 * The main process starts the window click-through and we tell it when the
 * cursor is genuinely over something interactive. `elementFromPoint` respects
 * the rendered shape, so the gaps inside the clip's bounding box pass through
 * too, not just the area outside it.
 */
window.addEventListener("mousemove", (e) => {
  // While the panel is open the window is solid by definition; continuing to
  // toggle setIgnoreMouseEvents at element boundaries makes it strobe.
  if (open) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const over = Boolean(el && el !== document.body && el !== document.documentElement);
  if (over !== solid) {
    solid = over;
    window.clippy.pointerOver(over);
  }
});

/* ── open / close ─────────────────────────────────────────────────────────── */
let open = false;
/**
 * Order matters and is the whole fix for the flicker.
 *
 * Opening: grow the window FIRST, and only then unhide the panel. Unhiding it
 * first draws a 372px panel inside a 96px window for several frames — the panel
 * appears clipped, then jumps, which reads as a flash.
 *
 * Closing: the reverse. Hide the panel, then shrink, so the panel is never
 * being painted while the window is mid-resize.
 */
let busy = false;
async function setOpen(next) {
  if (busy || next === open) return; // ignore clicks during a transition
  busy = true;
  open = next;
  try {
    if (open) {
      await window.clippy.resize(true);
      panel.hidden = false;
      solid = true;
      setState("listening");
      goal.focus();
    } else {
      panel.hidden = true;
      await window.clippy.resize(false);
      setState("idle");
      // resize() ALSO sets the window's ignore-mouse state in main. Our local
      // `solid` flag must follow it, or the two desync: `solid` stays true, the
      // next hover over the clip computes over===solid, no pointerOver is sent,
      // and the window stays click-through forever. Symptom is a clip that
      // opens once and is then dead to clicks.
      solid = false;
    }
  } finally {
    busy = false;
  }
}

/* ── drag vs click on one element ─────────────────────────────────────────────
 * `-webkit-app-region: drag` would handle the drag for free but swallows click
 * events, so the clip could be moved and never opened. Instead: track movement
 * from mousedown, and only treat mouseup as a click if the pointer stayed put.
 * screenX/screenY are used because they are stable while the window itself moves.
 */
const DRAG_THRESHOLD = 4;
let down = null;

clip.addEventListener("mousedown", (e) => {
  down = { x: e.screenX, y: e.screenY, moved: false };
  clip.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (!down) return;
  const dx = e.screenX - down.x;
  const dy = e.screenY - down.y;
  if (!down.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  down.moved = true;
  down.x = e.screenX;
  down.y = e.screenY;
  window.clippy.move(dx, dy);
});

window.addEventListener("mouseup", () => {
  if (!down) return;
  const wasClick = !down.moved;
  down = null;
  clip.style.cursor = "grab";
  if (wasClick) setOpen(!open);
});
document.getElementById("close")?.addEventListener("click", () => setOpen(false));

// §9.3 — ⌥Space summons from anywhere; the main process forwards it here.
window.clippy.onSummon(() => {
  if (!open) setOpen(true);
  else goal.focus();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open && gate.hidden) setOpen(false);
});

/* ── running a goal ───────────────────────────────────────────────────────── */
document.getElementById("ask")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = goal.value.trim();
  if (!text) return;
  goal.value = "";
  stepsEl.replaceChildren();
  setState("thinking");
  statusEl.textContent = "Working…";

  const result = await window.clippy.run(text);
  statusEl.textContent =
    result.kind === "done"
      ? `Done — ${result.steps} steps, $${result.cost.toFixed(4)}`
      : `${result.kind} — ${result.reason ?? ""}`;
});

document.getElementById("look")?.addEventListener("click", async () => {
  statusEl.textContent = "Looking at the page…";
  const shot = await window.clippy.look();
  statusEl.textContent = `Saw ${shot.width}×${shot.height}${shot.truncated ? " (clipped)" : ""}`;
});

/* ── live step list ───────────────────────────────────────────────────────── */
window.clippy.onStep((step) => {
  setState("acting");
  const li = document.createElement("li");
  const ok = step.outcome.kind === "ok";
  li.className = ok ? "ok" : "bad";

  const mark = document.createElement("span");
  mark.className = "mark";
  mark.textContent = ok ? "✓" : "✗";

  const what = document.createElement("span");
  what.className = "what";
  const a = step.action;
  what.textContent =
    a.kind === "navigate"
      ? `navigate ${a.url}`
      : a.kind === "fill" || a.kind === "select"
        ? `${a.kind} ${a.value}`
        : a.kind;

  li.append(mark, what);
  stepsEl.append(li);
  stepsEl.scrollTop = stepsEl.scrollHeight;
});

window.clippy.onState(({ state, message }) => {
  setState(state);
  if (message) statusEl.textContent = message;
});

/* ── the Submit gate (spec §9.5) ──────────────────────────────────────────────
 * Groups arrive already ordered and expanded/collapsed by buildGateView — the
 * decision about what deserves attention is made there, in tested code, not
 * here in the view.
 */
window.clippy.onGate(({ effect, view }) => {
  if (!open) setOpen(true);
  setState("blocked");

  gateHead.textContent =
    view.needsReview > 0
      ? `About to ${effect.kind} — ${view.needsReview} of ${view.total} field(s) need your eyes`
      : `About to ${effect.kind}`;

  gateGroups.replaceChildren();
  for (const group of view.groups) {
    const wrap = document.createElement("div");
    wrap.className = `group ${group.expanded ? "warn" : "safe"}`;

    const head = document.createElement("div");
    head.className = "group-head";
    const label = document.createElement("span");
    label.textContent = group.label;
    const count = document.createElement("span");
    count.textContent = String(group.items.length);
    head.append(label, count);

    const body = document.createElement("div");
    body.hidden = !group.expanded;
    for (const item of group.items) {
      const el = document.createElement("div");
      el.className = "item";

      const field = document.createElement("span");
      field.className = "field";
      field.textContent = item.field;

      // Expanded groups are the ones a human is being asked to vet, so their
      // values are editable in place (§9.5). Editing re-fills the field and
      // promotes it to `human` — once you have written it, it is no longer
      // something a model asserted.
      const value = document.createElement(group.expanded ? "textarea" : "span");
      if (group.expanded) {
        value.className = "edit";
        value.value = item.value;
        value.rows = Math.min(4, Math.ceil(item.value.length / 46));
        value.addEventListener("change", async () => {
          const result = await window.clippy.edit(item.ref, value.value);
          warn.textContent = result.warning ?? "";
          warn.hidden = !result.warning;
          el.classList.add("edited");
        });
      } else {
        value.textContent = item.value;
      }

      // A failing check WARNS, it does not block. §7.4 exists to stop a model
      // inventing facts about you, not to overrule you about your own history.
      const warn = document.createElement("div");
      warn.className = "warn-line";
      warn.hidden = true;

      el.append(field, value, warn);
      body.append(el);
    }

    // Collapsed groups can be opened, but never start open — that ordering is
    // the whole point of grouping by provenance.
    head.addEventListener("click", () => { body.hidden = !body.hidden; });
    wrap.append(head, body);
    gateGroups.append(wrap);
  }

  gate.hidden = false;
});

function answer(approved) {
  gate.hidden = true;
  setState(approved ? "acting" : "stuck");
  statusEl.textContent = approved ? "Approved" : "Declined";
  window.clippy.answerGate(approved);
}

document.getElementById("approve")?.addEventListener("click", () => answer(true));
document.getElementById("reject")?.addEventListener("click", () => answer(false));

setState("idle");
