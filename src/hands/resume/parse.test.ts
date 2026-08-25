import { describe, it, expect } from "vitest";
import { parseResume } from "./parse.js";

/**
 * Synthetic, but structurally faithful to a real Word resume converted by
 * anydoc — including the quirks that broke the first three versions of the
 * parser. Deliberately NOT the author's actual resume: tests are committed, and
 * a real profile is personal data (§10 gitignores `profile.json` for the same
 * reason).
 */
const FIXTURE = `**JANE Q. SAMPLE**

Springfield, IL 62701 **|** 555.123.4567 **|** jane@example.com

|  |  |
| --- | --- |
| **PROFESSIONAL EXPERIENCE** |  |
| **INITECH** | **Springfield, IL** |
| **Staff Engineer, Platform** | *February 2024 – Present* |
| • Led the billing migration end to end, cutting p95 latency 40% across three regions and removing a decade-old batch job<br>• Grew the on-call rotation from four to eleven engineers while halving pages per week |  |
| ****GLOBEX**** | ****Shelbyville, IL**** |
| ***Senior Engineer, Data*** | *September 2021 – January 2024* |

- Built the ingestion pipeline that now carries 2 billion events per day, replacing a vendor system that cost $400K a year
- Mentored six engineers through promotion while owning the team's reliability budget

| **VARIOUS CONTRACT WORK** |  |

- Advised three seed-stage startups on data architecture and hiring

### Springfield, IL September 2017 – May 2021

**EDUCATION**

|  |  |
| --- | --- |
| **SPRINGFIELD UNIVERSITY** |  |
| **School of Engineering \\| Bachelor of Science**<br>**Major: Computer Science** |  |

# ADDITIONAL INFORMATION

**Interests:** Bowling, competitive napping
`;

describe("parseResume — header", () => {
  const d = parseResume(FIXTURE);

  it("reads the name", () => {
    expect(d.name).toBe("JANE Q. SAMPLE");
  });

  it("reads email, phone, and location from the contact line", () => {
    expect(d.email).toBe("jane@example.com");
    expect(d.phone).toBe("555.123.4567");
    expect(d.location).toBe("Springfield, IL");
  });
});

describe("parseResume — employers", () => {
  const d = parseResume(FIXTURE);

  it("finds every dated employer", () => {
    expect(d.employers.map((e) => e.company)).toEqual(["INITECH", "GLOBEX"]);
  });

  it("reads titles and date ranges", () => {
    expect(d.employers[0]).toMatchObject({ title: "Staff Engineer, Platform", start: "2024" });
    expect(d.employers[0]!.end).toBeUndefined(); // "Present"
    expect(d.employers[1]).toMatchObject({ start: "2021", end: "2024" });
  });

  it("handles quadruple asterisks — real documents contain ****GLOBEX****", () => {
    expect(d.employers[1]!.company).toBe("GLOBEX");
  });

  it("collects bullets joined by <br>• inside a table cell", () => {
    expect(d.employers[0]!.bullets).toHaveLength(2);
    expect(d.employers[0]!.bullets[0]).toContain("billing migration");
  });

  it("collects bullets written as a markdown list", () => {
    expect(d.employers[1]!.bullets).toHaveLength(2);
    expect(d.employers[1]!.bullets[0]).toContain("ingestion pipeline");
  });

  it("does not mistake a date range for a title", () => {
    expect(d.employers.every((e) => !/\d{4}/.test(e.title))).toBe(true);
  });
});

describe("parseResume — things it cannot place", () => {
  const d = parseResume(FIXTURE);

  it("does NOT emit an undated grouping header as an employer", () => {
    // "VARIOUS CONTRACT WORK" has no date range, so it is a section heading.
    // Emitting it would produce an employer that fails ProfileSchema.
    expect(d.employers.map((e) => e.company)).not.toContain("VARIOUS CONTRACT WORK");
  });

  it("surfaces that heading instead of dropping it silently", () => {
    expect(d.unplaced.join(" ")).toContain("VARIOUS CONTRACT WORK");
  });

  it("says how many bullets were orphaned by it", () => {
    expect(d.unplaced.join(" ")).toMatch(/1 bullet/);
  });
});

describe("parseResume — education", () => {
  const d = parseResume(FIXTURE);

  it("finds the school", () => {
    expect(d.education[0]!.school).toBe("SPRINGFIELD UNIVERSITY");
  });

  it("keeps the whole degree past an ESCAPED pipe", () => {
    // `School of Engineering \| Bachelor of Science` — splitting on every pipe
    // truncated this at the escape and lost the degree.
    expect(d.education[0]!.degree).toContain("Bachelor of Science");
  });

  it("claims the graduation year from a stray heading above the section", () => {
    // Real documents put the education dates outside the EDUCATION block.
    expect(d.education[0]!.end).toBe("2021");
  });
});

describe("parseResume — robustness", () => {
  it("returns an empty draft for empty input rather than throwing", () => {
    const d = parseResume("");
    expect(d.employers).toEqual([]);
    expect(d.name).toBe("");
  });

  it("survives a document with no recognisable sections", () => {
    const d = parseResume("Just some prose.\n\nAnd more prose.\n");
    expect(d.employers).toEqual([]);
  });

  it("does not treat an en dash as a hyphen when parsing ranges", () => {
    // The separator in real documents is – (U+2013), not -.
    const withEnDash = FIXTURE.replace("September 2021 – January 2024", "September 2021 – January 2024");
    expect(parseResume(withEnDash).employers[1]!.end).toBe("2024");
  });
});
