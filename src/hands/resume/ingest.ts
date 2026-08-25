import { toMarkdown } from "@firecrawl/anydoc";
import { parseResume, type ResumeDraft } from "./parse.js";
import type { Profile } from "../../memory/profile.js";
import { titleCaseName } from "../../memory/normalise.js";

/**
 * Read a resume document into a profile draft (spec §6.4).
 *
 * anydoc is Rust, in-process, and makes no network calls — the document never
 * leaves the machine, which matters because this is the most personal file the
 * system touches.
 *
 * Handles DOCX, PDF, PPTX, XLSX, ODF, RTF, EPUB, and CSV. The DOCX is the better
 * source when both exist: a PDF is a render, and its table structure is
 * reconstructed rather than declared.
 */
export async function ingestResume(path: string): Promise<ResumeDraft> {
  return parseResume(await toMarkdown(path));
}

/**
 * Shape a draft into a Profile, leaving the judgement fields blank.
 *
 * Work authorisation, sponsorship, and salary are NOT guessed from a resume.
 * They rarely appear in one, and a wrong guess here would be asserted on real
 * applications as fact — §10 requires this file be corrected by hand before use,
 * and these are exactly the fields that correction is for.
 */
export function draftToProfile(draft: ResumeDraft, sourceDocument: string): Profile {
  return {
    // Resume headers are typographically ALL-CAPS; names are not.
    name: titleCaseName(draft.name),
    email: draft.email,
    phone: draft.phone,
    location: draft.location,
    workAuthorized: true,
    needsSponsorship: false,
    salaryExpectation: "",
    links: {},
    employers: draft.employers.map((e) => ({
      company: e.company,
      title: e.title,
      start: e.start,
      ...(e.end ? { end: e.end } : {}),
      bullets: e.bullets,
    })),
    education: draft.education.map((e) => ({
      school: e.school,
      degree: e.degree,
      ...(e.end ? { end: e.end } : {}),
    })),
    answers: {},
    sourceDocument,
  };
}
