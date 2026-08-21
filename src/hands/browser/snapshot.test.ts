import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { PAGE_SCRIPT, renderSnapshot } from "./snapshot.js";

/**
 * Build the page function the SAME way readPage() does — from the file text,
 * never from `.toString()` on a bundled function. This is the only construction
 * that exercises the production path.
 *
 * The parentheses are mandatory, not cosmetic. page-script.js opens with a
 * `// @ts-check` line comment, so `"return " + src` puts a line terminator
 * between `return` and the expression — ASI inserts a semicolon, the function
 * is discarded, and `new Function(...)()` yields `undefined`.
 */
function loadPageFn(): (doc: Document, generation: number) => any[] {
  return new Function("return (" + PAGE_SCRIPT + ")")();
}

function fakeDoc(html: string): Document {
  return parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
}

const collect = (html: string, gen = 1) => loadPageFn()(fakeDoc(html), gen);

describe("page-script", () => {
  it("is loadable as a standalone function — the production path", () => {
    expect(typeof loadPageFn()).toBe("function");
  });

  it("contains no bundler-injected helpers", () => {
    // If a bundler ever starts processing this file, these appear and the
    // function breaks inside the page. Cheap canary for the whole bug class.
    //
    // Matches CALL SITES, not bare identifiers: the file's own documentation
    // names `__name` while explaining the historical bug, and a broader regex
    // would fire on that prose. esbuild always emits these as invocations.
    expect(PAGE_SCRIPT).not.toMatch(/__name\s*\(|__spreadValues\s*\(|__async\s*\(|__toESM\s*\(/);
  });

  it("stamps each interactive element with a generation-scoped ref", () => {
    const nodes = collect(`<input id="a"><button id="b">Go</button>`, 3);
    expect(nodes.map((n) => n.ref)).toEqual(["g3-r0", "g3-r1"]);
  });

  it("prefers the label element for the accessible name", () => {
    expect(collect(`<label for="e">Email address</label><input id="e">`)[0].name).toBe("Email address");
  });

  it("falls back to aria-label, then placeholder", () => {
    expect(collect(`<input aria-label="Phone">`)[0].name).toBe("Phone");
    expect(collect(`<input placeholder="Your city">`)[0].name).toBe("Your city");
  });

  it("redacts password values", () => {
    const n = collect(`<label for="p">Password</label><input id="p" type="password" value="hunter2">`)[0];
    expect(n.value).toBe("•••");
    expect(n.redacted).toBe(true);
    expect(JSON.stringify(n)).not.toContain("hunter2");
  });

  it("redacts card fields and identity numbers", () => {
    expect(collect(`<input autocomplete="cc-number" value="4111111111111111">`)[0].value).toBe("•••");
    expect(collect(`<input name="ssn" value="123-45-6789">`)[0].value).toBe("•••");
  });

  it("still emits the password node so a login wall is recognisable", () => {
    const nodes = collect(`<input type="password" aria-label="Password" value="x">`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].role).toBe("password");
  });

  it("flags submit-capable controls", () => {
    const nodes = collect(`<form><button>Submit Application</button><button type="button">Help</button></form>`);
    expect(nodes[0].submitCapable).toBe(true);
    expect(nodes[1].submitCapable).toBe(false);
  });

  it("flags input[type=submit] and input[type=image]", () => {
    expect(collect(`<input type="submit" value="Apply">`)[0].submitCapable).toBe(true);
    expect(collect(`<input type="image" alt="Apply">`)[0].submitCapable).toBe(true);
  });

  it("neutralises newlines in page text so the tree cannot be forged", () => {
    const nodes = collect(`<input aria-label="Name&#10;g1-r1 button &quot;Cancel&quot;">`);
    expect(nodes[0].name).not.toContain("\n");
    expect(nodes[0].name).not.toContain('"');
  });

  it("caps absurdly long accessible names", () => {
    expect(collect(`<button>${"x".repeat(500)}</button>`)[0].name.length).toBeLessThanOrEqual(81);
  });

  it("emits disabled elements with a flag rather than hiding them", () => {
    const nodes = collect(`<button disabled>Submit</button>`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].disabled).toBe(true);
  });

  it("skips aria-hidden, hidden inputs, and [hidden]", () => {
    const nodes = collect(
      `<input aria-hidden="true"><input type="hidden"><input hidden><input aria-label="ok">`,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe("ok");
  });

  it("re-stamping with a new generation invalidates old refs", () => {
    const fn = loadPageFn();
    const doc = fakeDoc(`<input aria-label="x">`);
    fn(doc, 1);
    fn(doc, 2);
    expect(doc.querySelector(`[data-clippy-ref="g1-r0"]`)).toBeNull();
    expect(doc.querySelector(`[data-clippy-ref="g2-r0"]`)).not.toBeNull();
  });

  it("loads via the same wrapper readPage uses — parens prevent ASI", () => {
    // "return " + src would put a line terminator before the expression
    // (page-script.js opens with a comment), so ASI would yield undefined.
    expect(typeof new Function("return (" + PAGE_SCRIPT + ")")()).toBe("function");
    expect(new Function("return " + PAGE_SCRIPT)()).toBeUndefined();
  });
});

describe("renderSnapshot", () => {
  it("marks disabled and redacted nodes", () => {
    const out = renderSnapshot({
      generation: 1,
      url: "https://x.test/apply",
      title: "Apply",
      nodes: [
        { ref: "g1-r0", role: "password", name: "Password", value: "•••", submitCapable: false, disabled: false, redacted: true },
        { ref: "g1-r1", role: "button", name: "Submit", submitCapable: true, disabled: true },
      ],
    });
    expect(out).toContain("[redacted]");
    expect(out).toContain("[disabled]");
  });
});
