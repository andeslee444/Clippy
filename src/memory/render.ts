import type { Profile } from "./profile.js";

/**
 * Render a profile as the facts a model may use to fill a form.
 *
 * Everything here is sent to the model provider, so it carries only what is
 * needed to complete an application — the same data the user would type into
 * the form themselves.
 *
 * Blank fields are rendered as `(not provided — do not guess)` rather than
 * omitted. An absent key invites invention; an explicit refusal does not.
 */
export function renderProfileForModel(profile: Profile): string {
  const orDont = (v: string) => (v.trim() ? v : "(not provided — do not guess)");

  const lines = [
    `Name: ${profile.name}`,
    `Email: ${orDont(profile.email)}`,
    `Phone: ${orDont(profile.phone)}`,
    `Location: ${orDont(profile.location)}`,
    `Authorised to work: ${profile.workAuthorized ? "yes" : "no"}`,
    `Requires sponsorship: ${profile.needsSponsorship ? "yes" : "no"}`,
    `Salary expectation: ${orDont(profile.salaryExpectation)}`,
  ];

  for (const [k, v] of Object.entries(profile.links)) lines.push(`${k}: ${v}`);

  lines.push("", "Experience:");
  for (const e of profile.employers) {
    lines.push(`- ${e.title}, ${e.company} (${e.start}–${e.end ?? "present"})`);
    for (const b of e.bullets) lines.push(`    • ${b}`);
  }

  if (profile.education.length > 0) {
    lines.push("", "Education:");
    for (const e of profile.education) lines.push(`- ${e.degree}, ${e.school}${e.end ? ` (${e.end})` : ""}`);
  }

  const answers = Object.entries(profile.answers).filter(([, v]) => v.trim());
  if (answers.length > 0) {
    lines.push("", "Prepared answers:");
    for (const [q, a] of answers) lines.push(`- ${q}: ${a}`);
  }

  return lines.join("\n");
}
