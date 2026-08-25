/**
 * Parse a resume rendered as Markdown into a profile draft (spec §6.4, §10).
 *
 * Pure and text-in/object-out, so it can be tested against fixtures with no
 * document library and no filesystem. `ingest.ts` supplies the Markdown.
 *
 * The output is a DRAFT. §10 is explicit that extraction is a starting point and
 * not an authority — every factual claim in every application is checked against
 * the saved profile, so an extraction error here propagates into real
 * submissions. It is meant to be reviewed by hand before use.
 */

export interface DraftEmployer {
  company: string;
  title: string;
  start: string;
  end?: string;
  location?: string;
  bullets: string[];
}

export interface DraftEducation {
  school: string;
  degree: string;
  end?: string;
}

export interface ResumeDraft {
  name: string;
  email: string;
  phone: string;
  location: string;
  employers: DraftEmployer[];
  education: DraftEducation[];
  /** Anything the parser could not place, so nothing is silently dropped. */
  unplaced: string[];
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const PHONE = /(?:\+?\d{1,2}[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/;
const LOCATION = /\b([A-Z][a-zA-Z .'-]+),\s*([A-Z]{2})\b/;

/**
 * `Month YYYY – Month YYYY` or `– Present`.
 *
 * The separator is an EN DASH in real documents, not a hyphen. Matching only
 * `-` silently finds nothing and yields an employer list with no dates.
 */
const DATE_RANGE =
  /([A-Z][a-z]+\.?\s+(\d{4}))\s*[–—-]\s*(Present|Current|([A-Z][a-z]+\.?\s+(\d{4})))/i;

/** Strip emphasis runs. Real documents contain `****FACEBOOK****`, not just `**X**`. */
const unbold = (s: string): string => s.replace(/\*+/g, "").replace(/\\/g, "").trim();

const clean = (s: string): string => unbold(s).replace(/\s+/g, " ").trim();

/** Split a Markdown table row into its cells. Returns null for non-rows. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  if (/^\|[\s|:-]+\|$/.test(t)) return null; // separator row
  // Split on unescaped pipes only. A real document contained
  // `Rutgers Business School \| Bachelor of Science`, and splitting naively
  // truncated the degree at the escaped pipe.
  return t
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map(clean);
}

/** Looks like a company name: mostly capitals, not a sentence. */
function looksLikeCompany(text: string): boolean {
  if (!text || text.length < 2 || text.length > 60) return false;
  if (DATE_RANGE.test(text)) return false;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length / letters.length;
  return upper > 0.8;
}

/** Bullets arrive either as `- ` list items or `<br>•`-joined inside a table cell. */
function bulletsFrom(text: string): string[] {
  return text
    .split(/<br\s*\/?>|(?:^|\s)•\s*/g)
    .map((b) => clean(b))
    .filter((b) => b.length > 25);
}

export function parseResume(markdown: string): ResumeDraft {
  const lines = markdown.split("\n");
  const draft: ResumeDraft = {
    name: "",
    email: "",
    phone: "",
    location: "",
    employers: [],
    education: [],
    unplaced: [],
  };

  let section: "experience" | "education" | "other" = "other";
  let current: DraftEmployer | null = null;
  // A real document carried the education dates in a stray heading ABOVE the
  // EDUCATION section rather than inside it. Hold the last range seen so the
  // education entry can claim it rather than coming out undated.
  let strayRange: RegExpExecArray | null = null;

  const flush = () => {
    if (current && current.company) {
      if (current.start) {
        draft.employers.push(current);
      } else {
        // No date range means this was a grouping header ("VARIOUS STARTUP
        // EXPERIENCES"), not a job. Emitting it would produce an employer that
        // fails ProfileSchema; dropping it silently would lose its bullets.
        draft.unplaced.push(
          `heading "${current.company}" had no dates — ${current.bullets.length} bullet(s) need a home`,
        );
      }
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const flat = clean(line);
    if (!flat) continue;

    // ── header block ─────────────────────────────────────────────────────────
    if (!draft.name && /^\*\*[A-Z][A-Z.\s]+\*\*$/.test(line)) {
      draft.name = flat;
      continue;
    }
    if (!draft.email && EMAIL.test(flat)) {
      draft.email = EMAIL.exec(flat)![0];
      draft.phone = PHONE.exec(flat)?.[0] ?? "";
      const loc = LOCATION.exec(flat);
      draft.location = loc ? `${loc[1]}, ${loc[2]}` : "";
      continue;
    }

    // ── section switches ─────────────────────────────────────────────────────
    if (/professional experience|^experience$/i.test(flat)) { flush(); section = "experience"; continue; }
    if (/^education$/i.test(flat)) { flush(); section = "education"; continue; }
    if (/additional information|^interests?:|^languages?:/i.test(flat)) { flush(); section = "other"; continue; }

    const row = cells(line);

    if (section === "experience") {
      if (row) {
        const [first = "", second = ""] = row;

        // `| COMPANY | City, ST |`
        if (looksLikeCompany(first)) {
          flush();
          current = { company: first, title: "", start: "", bullets: [] };
          const loc = LOCATION.exec(second);
          if (loc) current.location = `${loc[1]}, ${loc[2]}`;
          continue;
        }

        // `| Title | Month YYYY – Month YYYY |`
        const range = DATE_RANGE.exec(second) ?? DATE_RANGE.exec(first);
        if (range && current) {
          if (!current.title && first && !DATE_RANGE.test(first)) current.title = first;
          current.start = range[2] ?? "";
          const endYear = range[5];
          if (endYear) current.end = endYear;
          continue;
        }

        // A cell carrying `<br>•`-joined bullets.
        for (const cell of row) {
          const bs = bulletsFrom(cell);
          if (bs.length > 0 && current) current.bullets.push(...bs);
        }
        continue;
      }

      if (/^[-*•]\s+/.test(line) && current) {
        current.bullets.push(clean(line.replace(/^[-*•]\s+/, "")));
        continue;
      }
    }

    if (section === "education") {
      if (!row) {
        const r = DATE_RANGE.exec(flat);
        if (r) strayRange = r;
      }
      if (row) {
        const [first = "", second = ""] = row;
        if (looksLikeCompany(first)) {
          draft.education.push({ school: first, degree: "" });
          continue;
        }
        const school = draft.education[draft.education.length - 1];
        if (school && first && !school.degree) {
          school.degree = first.split("<br>")[0]!.trim();
          const year = /(\d{4})/.exec(`${first} ${second}`);
          school.end = year?.[1] ?? strayRange?.[5] ?? strayRange?.[2];
        }
        continue;
      }
    }

    // Anything meaningful the parser could not place. Surfaced rather than
    // dropped, so a format it does not understand is visible instead of silent.
    const stray = DATE_RANGE.exec(flat);
    if (stray) strayRange = stray;

    if (flat.length > 30 && section === "experience") draft.unplaced.push(flat.slice(0, 100));
  }

  flush();
  return draft;
}
