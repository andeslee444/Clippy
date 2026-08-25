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

    // The posting is the second source of truth: claims about the employer or
    // the role are checked against it, claims about the candidate against the
    // profile. Without it, every genuinely tailored sentence is rejected.
    const verdict = checkIntegrity(answer.text, facts, [], posting);
    if (verdict.ok) return { ok: true, text: answer.text, cost, violations: [] };

    last = verdict.violations.map((v) => `${v.kind} "${v.value}"`);
    void explain;
  }

  return { ok: false, text: "", cost, violations: last };
}
