import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { connect, launchChrome } from "../hands/browser/connect.js";
import { readPage, renderSnapshot } from "../hands/browser/snapshot.js";
import { performEffect, resolve } from "../hands/browser/act.js";
import { capturePage } from "../hands/browser/capture.js";
import { GatedExecutor } from "../hands/execute.js";
import { AuditLog } from "../trust/audit.js";
import { makeTools } from "../brains/tools.js";
import { ClaudeActBrain } from "../brains/act-brain.js";
import { OpenAICompatBrain } from "../brains/openai-brain.js";
import { buildGateView } from "./gate-view.js";
import { loadProfile, factsOf, resumePathOf } from "../memory/profile.js";
import { renderProfileForModel } from "../memory/render.js";
import { checkIntegrity, explain } from "../trust/integrity.js";
import { DEFAULT_OBJECTIVE, type StepRecord } from "../orchestrator/types.js";
import type { ActBrain } from "../brains/types.js";
import type { Effect } from "../hands/types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Character sprite plus panel. Small when idle; the panel slides out from it. */
const IDLE = { width: 96, height: 116 };
const OPEN = { width: 460, height: 560 };

let win: BrowserWindow | null = null;
const steps: StepRecord[] = [];

function createWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay().workAreaSize;
  const w = new BrowserWindow({
    ...IDLE,
    x: display.width - IDLE.width - 40,
    y: display.height - IDLE.height - 60,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true },
  });
  w.setAlwaysOnTop(true, "floating");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.loadFile(join(here, "renderer", "index.html"));

  // §9.4 — an always-on-top window is a RECTANGLE and a paperclip is not.
  // Untreated, Clippy silently swallows every click in the transparent box
  // around it, which the user experiences as their desktop intermittently not
  // responding, with no error anywhere. The renderer hit-tests the cursor
  // against actual sprite pixels and tells us when to become solid.
  w.setIgnoreMouseEvents(true, { forward: true });
  ipcMain.on("clippy:pointer-over", (_e, over: boolean) => {
    w.setIgnoreMouseEvents(!over, { forward: true });
  });

  // `handle`, not `on`: the renderer must be able to AWAIT the resize before it
  // shows the panel. Showing it first draws a 372px panel inside a 96px window
  // for several frames, which is the flicker.
  ipcMain.handle("clippy:resize", (_e, open: boolean) => {
    const size = open ? OPEN : IDLE;
    const [x = 0, y = 0] = w.getPosition();
    const [w0 = 0, h0 = 0] = w.getSize();
    // Anchor the BOTTOM-RIGHT corner, not the top-left. The clip sits near the
    // bottom-right of the screen, so growing 96px -> 460px from a fixed top-left
    // pushes the whole window past the screen edge and the app appears to
    // vanish. Nothing errors; it is simply not where anyone is looking.
    // animate:false — an animated bounds change on a transparent frameless
    // window repaints the whole surface each frame and visibly strobes.
    w.setBounds({ x: x + (w0 - size.width), y: y + (h0 - size.height), ...size }, false);
    w.setIgnoreMouseEvents(!open, { forward: true });
  });

  // Dragging is done by hand — see the renderer. `-webkit-app-region: drag`
  // would be simpler but swallows click events entirely, and the clip has to be
  // both draggable AND clickable.
  ipcMain.on("clippy:move", (_e, { dx, dy }: { dx: number; dy: number }) => {
    const [x = 0, y = 0] = w.getPosition();
    w.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  return w;
}

async function main(): Promise<void> {
  await app.whenReady();
  win = createWindow();

  const session = await connect().catch((err: Error) => {
    win?.webContents.send("clippy:state", { state: "stuck", message: err.message });
    return null;
  });
  if (!session) return;

  const audit = new AuditLog(join(process.cwd(), "runs", `shell-${Date.now()}.jsonl`));

  // Loaded before the gate closure below, which reads `facts` — a `const`
  // declared after its use is a TDZ throw at the worst possible moment.
  // Optional: without it the gate honestly reports every value as `unknown`
  // rather than pretending it verified anything.
  const profile = await loadProfile(join(process.cwd(), "profile.json")).catch(() => null);
  const facts = profile ? factsOf(profile) : undefined;

  /** Blocks until the renderer answers. This is the whole gate integration. */
  const requestApproval = (effect: Effect): Promise<boolean> =>
    new Promise((resolveApproval) => {
      const view = buildGateView(steps, facts);
      win?.webContents.send("clippy:gate", { effect, view });
      ipcMain.once("clippy:gate-answer", (_e, approved: boolean) => resolveApproval(approved));
    });

  const executor = new GatedExecutor({
    audit,
    resolveFacts: async (effect) =>
      "ref" in effect ? (await resolve(session.page, effect.ref)).facts : undefined,
    perform: (effect) => performEffect(session.page, effect),
    requestApproval,
  });

  const context = profile ? renderProfileForModel(profile) : undefined;

  const tools = makeTools({
  resumePath: profile ? resumePathOf(profile) : undefined,
    facts,
    runEffect: (e) => executor.runEffect(e),
    readPage: async () =>
      renderSnapshot(await executor.observe({ kind: "readPage" }, () => readPage(session.page))),
    capturePage: () => executor.observe({ kind: "capturePage" }, () => capturePage(session.page)),
    onStep: (r) => {
      steps.push(r);
      win?.webContents.send("clippy:step", r);
    },
  });

  ipcMain.handle("clippy:run", async (_e, goal: string) => {
    steps.length = 0;
    win?.webContents.send("clippy:state", { state: "thinking" });
    const brain: ActBrain =
      (process.env.CLIPPY_BRAIN ?? "anthropic") === "anthropic"
        ? new ClaudeActBrain()
        : OpenAICompatBrain.fromEnv();
    try {
      const result = await brain.pursue({ ...DEFAULT_OBJECTIVE, goal, ...(context ? { context } : {}) }, tools);
      win?.webContents.send("clippy:state", {
        state: result.kind === "done" ? "done" : "stuck",
        message: "reason" in result ? result.reason : undefined,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      win?.webContents.send("clippy:state", { state: "stuck", message });
      return { kind: "failed", reason: message, steps: 0, cost: 0 };
    }
  });

  /**
   * Edit a value at the gate (spec §9.5).
   *
   * Re-fills the field, promotes provenance to `human`, and re-runs the §7.4
   * check. A failing check WARNS rather than blocks: that validator exists to
   * stop a model inventing facts about the user, not to overrule the user about
   * their own application. They are the authority on their own history.
   */
  ipcMain.handle("clippy:edit", async (_e, { ref, value }: { ref: string; value: string }) => {
    await executor.runEffect({ kind: "fill", ref, value, provenance: "human" });
    if (!facts) return { ok: true, warning: null };
    const verdict = checkIntegrity(value, facts);
    return { ok: verdict.ok, warning: verdict.ok ? null : explain(verdict) };
  });

  ipcMain.handle("clippy:look", () =>
    executor.observe({ kind: "capturePage" }, () => capturePage(session.page)),
  );

  // §9.3 — summon from anywhere.
  globalShortcut.register("Alt+Space", () => {
    win?.webContents.send("clippy:summon");
    win?.showInactive();
  });

  // §7.2 — panic. Global, works unfocused, works mid-gate. Releases the browser
  // and leaves Chrome running so login sessions survive.
  globalShortcut.register("Alt+Shift+Escape", async () => {
    const seq = await audit.attempt({ kind: "readPage" }, { gated: false });
    await audit.outcome(seq, { ok: false, error: "aborted by user (panic hotkey)" });
    win?.webContents.send("clippy:state", { state: "idle", message: "aborted" });
    await session.close();
    app.quit();
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());
}

if (process.argv.includes("--launch-chrome")) {
  launchChrome();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  app.quit();
});
