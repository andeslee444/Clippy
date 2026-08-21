import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { connect, launchChrome } from "../hands/browser/connect.js";
import { readPage, renderSnapshot } from "../hands/browser/snapshot.js";
import { performEffect, resolve } from "../hands/browser/act.js";
import { capturePage } from "../hands/browser/capture.js";
import { GatedExecutor } from "../hands/execute.js";
import { AuditLog } from "../trust/audit.js";
import type { Action, Effect } from "../hands/types.js";

const HELP = `
  read                 snapshot the page and print the ref'd tree
  shot                 full-page screenshot -> /tmp/clippy-capture.png
  go <url>             navigate
  click <ref>          click by ref
  fill <ref> <value>   fill by ref
  select <ref> <val>   choose an option
  submit <ref>         submit (always gated)
  help                 this
  quit
`;

if (process.argv.includes("--launch")) {
  launchChrome();
  console.log("Chrome launching with the dedicated profile.");
  process.exit(0);
}

const session = await connect();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const audit = new AuditLog(join(process.cwd(), "runs", `spine-${Date.now()}.jsonl`));

const executor = new GatedExecutor({
  audit,
  resolveFacts: async (effect) =>
    "ref" in effect ? (await resolve(session.page, effect.ref)).facts : undefined,
  perform: (effect) => performEffect(session.page, effect),
  requestApproval: async (effect, facts) => {
    const why = facts?.submitCapable
      ? "element submits a form"
      : facts?.formless
        ? "page has no <form>, so submit detection is unavailable"
        : "irreversible or outward-facing";
    console.log(`\n⏸  GATED: ${effect.kind} — ${why}`);
    console.log(`   ${JSON.stringify(effect)}`);
    const answer = await rl.question("   approve? [y/N] ");
    return answer.trim().toLowerCase() === "y";
  },
});

/** What the executor is currently working on, so an abort names the right thing. */
let inFlight: Action = { kind: "readPage" };

let aborting = false;
process.on("SIGINT", async () => {
  if (aborting) process.exit(130);
  aborting = true;
  // Log the abort BEFORE releasing the browser, for the same reason attempts are
  // logged before execution: the record has to survive the thing it describes.
  const seq = await audit.attempt(inFlight, { gated: false });
  await audit.outcome(seq, { ok: false, error: "aborted by user (SIGINT)" });
  console.log("\n⏹  aborted — releasing browser, Chrome stays up");
  await session.close();
  process.exit(130);
});

console.log(HELP);

for (;;) {
  const line = (await rl.question("clippy> ")).trim();
  const [cmd, ...rest] = line.split(/\s+/);
  if (!cmd) continue;
  if (cmd === "quit") break;
  if (cmd === "help") { console.log(HELP); continue; }

  try {
    if (cmd === "read") {
      inFlight = { kind: "readPage" };
      const snap = await executor.observe({ kind: "readPage" }, () => readPage(session.page));
      console.log(renderSnapshot(snap));
      console.log(
        `\n(generation ${snap.generation}, ${snap.nodes.length} elements` +
          `${snap.formless ? ", NO <form> — every click will gate" : ""})`,
      );
      continue;
    }
    if (cmd === "shot") {
      inFlight = { kind: "capturePage" };
      const c = await executor.observe({ kind: "capturePage" }, () => capturePage(session.page));
      const { writeFile } = await import("node:fs/promises");
      await writeFile("/tmp/clippy-capture.png", Buffer.from(c.base64, "base64"));
      console.log(`${c.width}x${c.height} truncated=${c.truncated} -> /tmp/clippy-capture.png`);
      continue;
    }

    const effect: Effect | null =
      cmd === "go"     ? { kind: "navigate", url: rest[0]! }
    : cmd === "click"  ? { kind: "click", ref: rest[0]! }
    : cmd === "submit" ? { kind: "submit", ref: rest[0]! }
    : cmd === "fill"   ? { kind: "fill", ref: rest[0]!, value: rest.slice(1).join(" ") }
    : cmd === "select" ? { kind: "select", ref: rest[0]!, value: rest.slice(1).join(" ") }
    : null;

    if (!effect) { console.log(HELP); continue; }
    inFlight = effect;
    await executor.runEffect(effect);
    console.log("ok");
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  }
}

rl.close();
await session.close();
