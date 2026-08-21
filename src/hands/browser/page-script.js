// @ts-check
/*
 * RUNS INSIDE THE PAGE. Loaded as TEXT by snapshot.ts and evaluated there.
 *
 * Do not import anything here. Do not reference anything outside this
 * expression. Do not let a bundler process this file — that is what broke the
 * two previous versions of this code (a module-scope `SELECTOR`, then `__name`
 * injected by esbuild's keepNames around inner functions).
 *
 * The file is exactly one parenthesised function expression, so
 * `new Function("return " + text)()` yields the function.
 */
(function stampAndCollect(doc, generation) {
  var SELECTOR =
    "input, textarea, select, button, a[href], [role=button], [contenteditable=true]";
  var SENSITIVE_NAME = /ssn|social|passport|tax|routing|account|cvv|cvc/i;
  var REDACTED = "•••";
  var MAX_NAME = 80;

  var stale = doc.querySelectorAll("[data-clippy-ref]");
  for (var s = 0; s < stale.length; s++) {
    stale[s].removeAttribute("data-clippy-ref");
    stale[s].removeAttribute("data-clippy-submit");
  }

  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "file") return "file";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") {
      return "button";
    }
    if (type === "password") return "password";
    return "textbox";
  }

  function labelFor(el) {
    var id = el.getAttribute("id");
    if (!id) return null;
    var labels = doc.querySelectorAll("label[for]");
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].getAttribute("for") === id) return labels[i];
    }
    return null;
  }

  /* Page text is attacker-controlled. Collapse whitespace on EVERY path so a
     crafted aria-label cannot forge a line break in the rendered tree, escape
     quotes so it cannot forge a field boundary, and cap the length. */
  function sanitize(raw) {
    if (!raw) return "";
    var flat = String(raw).replace(/\s+/g, " ").replace(/"/g, "'").trim();
    return flat.length > MAX_NAME ? flat.slice(0, MAX_NAME) + "…" : flat;
  }

  function nameOf(el) {
    var label = labelFor(el);
    if (label && label.textContent && label.textContent.trim()) return sanitize(label.textContent);
    if (el.getAttribute("aria-label")) return sanitize(el.getAttribute("aria-label"));
    if (el.getAttribute("placeholder")) return sanitize(el.getAttribute("placeholder"));
    return sanitize(el.textContent);
  }

  /* Spec §7.5: credentials must never leave the page, because the takeover
     protocol has the user type a real password into this very browser. */
  function isSecret(el) {
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    var auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.indexOf("cc-") === 0 || auto === "current-password" || auto === "new-password") {
      return true;
    }
    var ident = (el.getAttribute("name") || "") + " " + (el.getAttribute("id") || "");
    return SENSITIVE_NAME.test(ident);
  }

  /* Activating this submits a form — so a `click` on it must be refused (§7.1). */
  function isSubmitCapable(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && (type === "submit" || type === "image")) return true;
    if (tag === "button" && type !== "button" && type !== "reset") {
      return Boolean(el.closest("form")) || type === "submit";
    }
    return false;
  }

  function isDisabled(el) {
    try {
      return el.matches(":disabled");
    } catch (e) {
      return el.hasAttribute("disabled");
    }
  }

  function isRendered(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if ((el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
    if (el.hasAttribute("hidden")) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility();
    if (typeof el.getClientRects === "function") return el.getClientRects().length > 0;
    return true;
  }

  var out = [];
  var els = doc.querySelectorAll(SELECTOR);
  var i = 0;
  for (var n = 0; n < els.length; n++) {
    var el = els[n];
    if (!isRendered(el)) continue;

    var ref = "g" + generation + "-r" + i++;
    el.setAttribute("data-clippy-ref", ref);

    var submitCapable = isSubmitCapable(el);
    if (submitCapable) el.setAttribute("data-clippy-submit", "1");

    var secret = isSecret(el);
    var rawValue = el.value !== undefined && el.value !== null
      ? el.value
      : el.getAttribute("value");
    var value = secret ? (rawValue ? REDACTED : undefined) : (sanitize(rawValue) || undefined);

    out.push({
      ref: ref,
      role: roleOf(el),
      name: nameOf(el),
      value: value,
      submitCapable: submitCapable,
      disabled: isDisabled(el),
      redacted: secret || undefined,
    });
  }
  return out;
})
