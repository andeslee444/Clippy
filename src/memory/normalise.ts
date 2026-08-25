import type { Profile } from "./profile.js";

/**
 * ALL-CAPS is a resume *typographic* convention, not how a name is spelled.
 *
 * Extraction preserved the header faithfully — "ANDES H. LEE" — and every
 * application would then carry shouty capitals into a real employer's database.
 * Only fully-uppercase words are touched; "McTestface" and "de Silva" are left
 * alone because they are already mixed case and therefore deliberate.
 */
export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => {
      if (word !== word.toUpperCase()) return word; // already mixed — leave it
      if (/^[A-Z]\.$/.test(word)) return word; // initial like "H."
      return word
        .split("-")
        .map((part) =>
          part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join("-");
    })
    .join(" ");
}

export interface ProfileWarning {
  field: string;
  why: string;
}

/**
 * Fields a resume cannot answer, which an application will nonetheless ask.
 *
 * These are exactly the values §10 says must be corrected by hand: extraction
 * left them blank or defaulted, and a default asserted on a real application is
 * a claim nobody verified. Surfaced rather than silently shipped.
 */
export function profileWarnings(profile: Profile): ProfileWarning[] {
  const out: ProfileWarning[] = [];
  if (!profile.salaryExpectation.trim()) {
    out.push({
      field: "salaryExpectation",
      why: "blank — forms ask for it, and it cannot be guessed from a resume",
    });
  }
  if (!profile.phone.trim()) out.push({ field: "phone", why: "blank" });
  if (!profile.location.trim()) out.push({ field: "location", why: "blank" });
  if (Object.keys(profile.links).length === 0) {
    out.push({ field: "links", why: "no LinkedIn or portfolio — most forms ask" });
  }
  // These two are DEFAULTED by ingestion, never extracted. A default here is an
  // unverified claim about immigration status asserted to an employer.
  out.push({
    field: "workAuthorized / needsSponsorship",
    why: `currently ${profile.workAuthorized ? "authorised" : "not authorised"}, ` +
      `${profile.needsSponsorship ? "needs" : "does not need"} sponsorship — ` +
      `defaulted by ingestion, confirm this is right`,
  });
  return out;
}
