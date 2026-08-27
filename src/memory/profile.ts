import { existsSync } from "node:fs";
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
  /**
   * Fields the user has explicitly confirmed, as opposed to values ingestion
   * defaulted.
   *
   * `workAuthorized: true` looks identical whether a person said so or a parser
   * guessed it, and the difference matters enormously when it is asserted to an
   * employer. This is what lets the warning stop nagging once a value is
   * genuinely verified, instead of becoming permanent noise everyone learns to
   * scroll past.
   */
  verifiedFields: z.array(z.string()).default([]),
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

/**
 * The file to attach to an application, from the document the profile was built
 * from.
 *
 * Prefers a PDF sibling when one exists. Résumés are commonly kept as a .docx
 * that is exported to .pdf, `ingest` is usually pointed at whichever was handy,
 * and the PDF is the one that survives an applicant tracking system with its
 * layout intact. Returns undefined when no source document is recorded, so the
 * caller refuses rather than inventing a path.
 */
export function resumePathOf(profile: Profile): string | undefined {
  const source = profile.sourceDocument;
  if (!source) return undefined;
  const pdf = source.replace(/\.(docx?|rtf|txt|pages)$/i, ".pdf");
  return pdf !== source && existsSync(pdf) ? pdf : source;
}
