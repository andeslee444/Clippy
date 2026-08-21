import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { stampAndCollect } from "./snapshot.js";

/** Real DOM semantics in Node, no browser. */
function fakeDoc(html: string): Document {
  return parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
}

describe("stampAndCollect", () => {
  it("stamps each interactive element with a generation-scoped ref", () => {
    const doc = fakeDoc(`<input id="a"><button id="b">Go</button>`);
    const nodes = stampAndCollect(doc, 3);
    expect(nodes.map((n) => n.ref)).toEqual(["g3-r0", "g3-r1"]);
    expect(doc.getElementById("a")!.getAttribute("data-clippy-ref")).toBe("g3-r0");
  });

  it("prefers the label element for the accessible name", () => {
    const doc = fakeDoc(`<label for="e">Email address</label><input id="e">`);
    expect(stampAndCollect(doc, 1)[0]!.name).toBe("Email address");
  });

  it("falls back to aria-label, then placeholder", () => {
    const aria = fakeDoc(`<input aria-label="Phone">`);
    expect(stampAndCollect(aria, 1)[0]!.name).toBe("Phone");
    const ph = fakeDoc(`<input placeholder="Your city">`);
    expect(stampAndCollect(ph, 1)[0]!.name).toBe("Your city");
  });

  it("uses trimmed text content for buttons and links", () => {
    const doc = fakeDoc(`<button>  Submit Application \n </button>`);
    expect(stampAndCollect(doc, 1)[0]!.name).toBe("Submit Application");
  });

  it("records role and current value", () => {
    const doc = fakeDoc(`<input type="email" value="a@b.c" aria-label="Email">`);
    const n = stampAndCollect(doc, 1)[0]!;
    expect(n.role).toBe("textbox");
    expect(n.value).toBe("a@b.c");
  });

  it("skips hidden and disabled elements", () => {
    const doc = fakeDoc(
      `<input aria-hidden="true"><input disabled><input type="hidden"><input aria-label="ok">`,
    );
    const nodes = stampAndCollect(doc, 1);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe("ok");
  });

  it("re-stamping with a new generation invalidates old refs", () => {
    const doc = fakeDoc(`<input aria-label="x">`);
    stampAndCollect(doc, 1);
    stampAndCollect(doc, 2);
    expect(doc.querySelector(`[data-clippy-ref="g1-r0"]`)).toBeNull();
    expect(doc.querySelector(`[data-clippy-ref="g2-r0"]`)).not.toBeNull();
  });
});
