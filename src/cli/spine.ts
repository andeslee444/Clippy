import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { connect, launchChrome } from "../hands/browser/connect.js";
import { readPage, renderSnapshot } from "../hands/browser/snapshot.js";
import { performEffect, resolve } from "../hands/browser/act.js";
import { capturePage } from "../hands/browser/capture.js";
import { GatedExecutor } from "../hands/execute.js";
import { AuditLog } from "../trust/audit.js";
import type { Action, Effect } from "../hands/types.js";
import { makeTools } from "../brains/tools.js";
import { ScriptedBrain, type ScriptedStep } from "../brains/scripted-brain.js";
import { ClaudeActBrain } from "../brains/act-brain.js";
import { OpenAICompatBrain } from "../brains/openai-brain.js";
import type { ActBrain } from "../brains/types.js";
import { DEFAULT_OBJECTIVE, type StepRecord } from "../orchestrator/types.js";
import { ingestResume, draftToProfile } from "../hands/resume/ingest.js";
import { loadProfile, saveProfile, factsOf, type Profile } from "../memory/profile.js";
import { JenovaKnowBrain } from "../brains/know-brain.js";
import { draftTailored } from "../brains/draft.js";

const HELP = `
  read                 snapshot the page and print the ref'd tree
  shot                 full-page screenshot -> /tmp/clippy-capture.png
  go <url>             navigate
  click <ref>          click by ref
  fill <ref> <value>   fill by ref
  select <ref> <val>   choose an option
  submit <ref>         submit (always gated)
  do <goal>            let the brain pursue a goal (uses CLIPPY_BRAIN)
  demo <kind> <name> [v] run one scripted effect by field name — no API key

  ingest <path>        read a resume into profile.json (docx, pdf, …)
  profile              summarise the loaded profile
  fit                  score the CURRENT PAGE against your profile
  draft                draft a tailored bullet for the current page, validated

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

const PROFILE_PATH = join(process.cwd(), "profile.json");

/** Loaded on demand — most commands do not need it, and it may not exist yet. */
let profile: Profile | null = null;
async function requireProfile(): Promise<Profile | null> {
  if (profile) return profile;
  try {
    profile = await loadProfile(PROFILE_PATH);
    return profile;
  } catch (err) {
    console.error(`✗ no usable profile at ${PROFILE_PATH}`);
    console.error(`  run: ingest <path-to-your-resume.docx>`);
    console.error(`  (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
    return null;
  }
}

/** The current page, rendered as the posting text a knowledge turn reasons over. */
async function currentPosting(): Promise<string> {
  inFlight = { kind: "readPage" };
  const snap = await executor.observe({ kind: "readPage" }, () => readPage(session.page));
  const text = await session.page.evaluate(() => document.body.innerText.slice(0, 6000));
  return `Page: ${snap.title}\nURL: ${snap.url}\n\n${text}`;
}

const steps: StepRecord[] = [];
const brainTools = makeTools({
  runEffect: (effect) => executor.runEffect(effect),
  readPage: async () => {
    inFlight = { kind: "readPage" };
    return renderSnapshot(await executor.observe({ kind: "readPage" }, () => readPage(session.page)));
  },
  capturePage: async () => {
    inFlight = { kind: "capturePage" };
    return executor.observe({ kind: "capturePage" }, () => capturePage(session.page));
  },
  onStep: (r) => steps.push(r),
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

    if (cmd === "ingest") {
      const path = rest.join(" ");
      if (!path) { console.log("usage: ingest <path-to-resume.docx|pdf>"); continue; }
      const draft = await ingestResume(path);
      await saveProfile(PROFILE_PATH, draftToProfile(draft, path));
      profile = await loadProfile(PROFILE_PATH);
      console.log(`saved ${PROFILE_PATH}`);
      console.log(`  ${draft.employers.length} employers, ${draft.education.length} education`);
      for (const e of draft.employers) {
        console.log(`    ${e.company.padEnd(30)} ${e.start}–${e.end ?? "present"}  ${e.bullets.length}b`);
      }
      if (draft.unplaced.length > 0) {
        // Surfaced, never dropped — a format the parser did not understand should
        // be visible rather than silently absent from the facts it vouches for.
        console.log(`  ⚠ ${draft.unplaced.length} item(s) could not be placed:`);
        for (const u of draft.unplaced) console.log(`      ${u.slice(0, 90)}`);
      }
      console.log(`  ⚠ review by hand before use — work authorisation, sponsorship, and`);
      console.log(`    salary are NOT extracted from a resume and are left blank.`);
      continue;
    }

    if (cmd === "profile") {
      const p = await requireProfile();
      if (!p) continue;
      const f = factsOf(p);
      console.log(`${p.name} · ${p.location}`);
      console.log(`  employers: ${p.employers.length}   education: ${p.education.length}`);
      console.log(`  work authorised: ${p.workAuthorized}   needs sponsorship: ${p.needsSponsorship}`);
      console.log(`  salary: ${p.salaryExpectation || "(blank — set this by hand)"}`);
      console.log(`  validator can vouch for: ${f.organisations.length} orgs, ${f.titles.length} titles, ` +
        `${f.years.size} years, ${f.metrics.length} metrics`);
      continue;
    }

    if (cmd === "fit") {
      const p = await requireProfile();
      if (!p) continue;
      const posting = await currentPosting();
      const answer = await JenovaKnowBrain.fromEnv().ask(
        "assessFit",
        `Score this candidate against this job posting from 1-10 and give two sentences of ` +
          `reasoning. Be blunt about gaps.\n\nPOSTING:\n${posting}\n\nCANDIDATE:\n${JSON.stringify(p.employers)}`,
      );
      console.log(`\n${answer.text.trim()}\n\n($${answer.cost.toFixed(4)})`);
      continue;
    }

    if (cmd === "draft") {
      const p = await requireProfile();
      if (!p) continue;
      const posting = await currentPosting();
      const result = await draftTailored(
        JenovaKnowBrain.fromEnv(),
        factsOf(p),
        `Write ONE tailored resume bullet for this posting, using ONLY facts from the ` +
          `candidate's experience. Invent no employers, numbers, or dates. Reply with the ` +
          `bullet only.\n\nPOSTING:\n${posting}\n\nEXPERIENCE:\n${JSON.stringify(p.employers)}`,
        3,
      );
      if (result.ok) {
        console.log(`\n${result.text.trim()}\n\n✓ every claim traced to your profile ($${result.cost.toFixed(4)})`);
      } else {
        // §7.4: text that failed validation is never shown as usable output.
        console.log(`\n✗ could not produce a bullet that survives the integrity check ($${result.cost.toFixed(4)})`);
        console.log(`  unfounded: ${result.violations.join("; ")}`);
      }
      continue;
    }

    if (cmd === "do" || cmd === "demo") {
      const goal = rest.join(" ");
      // demo takes an effect KIND and a NAME FRAGMENT, never a ref: the brain's
      // own opening readPage bumps the generation, so any ref typed at the
      // prompt is stale by the time the effect runs.
      const [kind, match, ...v] = rest;
      const value = v.join(" ");
      const scripted =
        kind && match && ["fill", "select", "click", "submit"].includes(kind)
          ? { kind: kind as ScriptedStep["kind"], match, value }
          : null;

      if (cmd === "demo" && !scripted) {
        console.log('usage: demo <fill|select|click|submit> <name-fragment> [value]');
        console.log('  e.g. demo fill First Testington');
        console.log('       demo submit Submit');
        continue;
      }

      const brain: ActBrain =
        cmd === "demo"
          ? new ScriptedBrain([scripted!])
          : (process.env.CLIPPY_BRAIN ?? "anthropic") === "anthropic"
            ? new ClaudeActBrain()
            : OpenAICompatBrain.fromEnv();
      steps.length = 0;
      const result = await brain.pursue({ ...DEFAULT_OBJECTIVE, goal }, brainTools);
      console.log(
        `\n${result.kind.toUpperCase()} — ${result.steps} steps, $${result.cost.toFixed(4)}` +
          ("reason" in result ? `\n  ${result.reason}` : ""),
      );
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
