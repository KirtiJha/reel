/**
 * The in-page observer for `reel capture`.
 *
 * Kept as a string rather than a function handed to `addInitScript`: the
 * bundler rewrites function declarations (esbuild's `keepNames` emits a
 * `__name` helper that doesn't exist in the page), and injected code that
 * depends on the build's output shape breaks in ways that look like the page's
 * fault. A string is the source that runs.
 *
 * It reports what the user *meant* — the element and every honest way of naming
 * it, with how many things each name matches — and leaves the choice of
 * selector to `selector.ts`, where it can be tested without a browser.
 */

/** The name of the binding Node exposes for the page to report through. */
export const BINDING = "__reelCaptureEvent";

/** Container id for the capture UI, so its own clicks are never recorded. */
export const UI_ID = "__reel_capture_ui__";

export interface ObservedEvent {
  type: "click" | "dblclick" | "input" | "key" | "caption" | "beat" | "finish";
  candidates?: { kind: string; selector: string; matches: number }[];
  /** Final value of a field, for input events. */
  value?: string;
  /** The key pressed, for key events. */
  key?: string;
  /** Caption text, when the user annotates from the toolbar. */
  text?: string;
  /** Element tag, used to decide between `type` and `fill`. */
  tag?: string;
  /** Input type, so a checkbox isn't treated as a text field. */
  inputType?: string;
  url?: string;
}

export const OBSERVER_SCRIPT = `
(() => {
  if (window.__reelObserver) return;
  window.__reelObserver = true;

  const UI_ID = ${JSON.stringify(UI_ID)};
  const BINDING = ${JSON.stringify(BINDING)};
  const pending = [];
  let steps = 0;

  const send = (event) => {
    const fn = window[BINDING];
    // The binding is installed by the driver and the page may beat it here;
    // holding events beats dropping the first click of the session.
    if (typeof fn === "function") fn(event);
    else pending.push(event);
  };
  const flush = () => {
    const fn = window[BINDING];
    if (typeof fn !== "function") return;
    while (pending.length) fn(pending.shift());
  };
  setInterval(flush, 200);

  const norm = (v) => (v || "").replace(/\\s+/g, " ").trim();

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      if (t === "number" || t === "text" || t === "email" || t === "tel" || t === "url" || t === "password") return "textbox";
    }
    return "";
  };

  const labelFor = (el) => {
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return norm(label.textContent);
    }
    const wrapping = el.closest("label");
    return wrapping ? norm(wrapping.textContent) : "";
  };

  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      if (parts.length) return norm(parts.map((p) => p.textContent).join(" "));
    }
    const label = labelFor(el);
    if (label) return label;
    if (el.tagName === "IMG") return norm(el.getAttribute("alt"));
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (t === "submit" || t === "button") return norm(el.value);
      return norm(el.getAttribute("placeholder"));
    }
    const title = el.getAttribute("title");
    return norm(el.innerText || el.textContent) || norm(title);
  };

  /** Elements matching a role+name pair, the way Playwright role= resolves. */
  const countRole = (role, name) => {
    const wanted = name.toLowerCase();
    let n = 0;
    for (const el of document.querySelectorAll("*")) {
      if (roleOf(el) !== role) continue;
      if (name && nameOf(el).toLowerCase() !== wanted) continue;
      n++;
    }
    return n;
  };

  /**
   * Playwright text= takes the smallest element containing the string, so a
   * parent that merely wraps the match is not another match.
   */
  const countText = (text) => {
    const wanted = text.toLowerCase();
    let n = 0;
    for (const el of document.querySelectorAll("*")) {
      if (!norm(el.textContent).toLowerCase().includes(wanted)) continue;
      let deeper = false;
      for (const child of el.children) {
        if (norm(child.textContent).toLowerCase().includes(wanted)) { deeper = true; break; }
      }
      if (!deeper) n++;
    }
    return n;
  };

  const countCss = (selector) => {
    try { return document.querySelectorAll(selector).length; } catch { return 0; }
  };

  /** A short structural path — the fallback when nothing names the element. */
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];

  const candidatesFor = (el) => {
    const out = [];

    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) {
        const sel = "[" + attr + '="' + value.replace(/"/g, '\\\\"') + '"]';
        out.push({ kind: "testid", selector: sel, matches: countCss(sel) });
        break;
      }
    }

    if (el.id) out.push({ kind: "id", selector: "#" + el.id, matches: countCss("#" + CSS.escape(el.id)) });

    const role = roleOf(el);
    const name = nameOf(el);
    if (role && name) {
      const quoted = /[\\s\\]"']/.test(name) ? JSON.stringify(name) : name;
      out.push({ kind: "role", selector: "role=" + role + "[name=" + quoted + "]", matches: countRole(role, name) });
    } else if (role) {
      out.push({ kind: "role", selector: "role=" + role, matches: countRole(role, "") });
    }

    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder) {
      const sel = '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
      out.push({ kind: "placeholder", selector: sel, matches: countCss(sel) });
    }

    const text = norm(el.innerText || el.textContent);
    if (text) out.push({ kind: "text", selector: "text=" + text, matches: countText(text) });

    const path = cssPath(el);
    if (path) out.push({ kind: "css", selector: path, matches: countCss(path) });

    return out;
  };

  const ours = (node) => !!(node && node.closest && node.closest("#" + UI_ID));

  /** The field currently being typed into, so a run of keystrokes counts once. */
  let lastTyped = null;

  document.addEventListener("click", (e) => {
    const el = e.target;
    if (!el || ours(el)) return;
    lastTyped = null;
    steps++;
    render();
    send({ type: "click", candidates: candidatesFor(el), tag: el.tagName.toLowerCase(), url: location.href });
  }, true);

  // Listening on input rather than change: change fires on blur, so typing a
  // value and then pressing Enter would be reported in the wrong order — the
  // submit before the text that was submitted. Per-keystroke events are
  // coalesced downstream, where the ordering is already correct.
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!el || ours(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    // Checkboxes and radios are clicks, not text entry; the click listener has
    // already recorded them.
    if (type === "checkbox" || type === "radio") return;
    // One field is one step however many keys it took, so the count on the
    // toolbar matches the spec the user will get.
    if (lastTyped !== el) { steps++; lastTyped = el; }
    render();
    send({
      type: "input",
      candidates: candidatesFor(el),
      value: el.value,
      tag,
      inputType: type,
      url: location.href,
    });
  }, true);

  document.addEventListener("keydown", (e) => {
    if (ours(e.target)) return;
    const named = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!named.includes(e.key) && !(e.metaKey || e.ctrlKey)) return;
    if (e.key === "Shift" || e.key === "Control" || e.key === "Meta" || e.key === "Alt") return;
    const parts = [];
    if (e.ctrlKey) parts.push("Control");
    if (e.metaKey) parts.push("Meta");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey && e.key.length > 1) parts.push("Shift");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    steps++;
    render();
    send({ type: "key", key: parts.join("+"), candidates: candidatesFor(e.target), url: location.href });
  }, true);

  /* --- The toolbar: state, and the two things only a human can supply. --- */

  let ui = null;
  let countEl = null;

  const render = () => {
    if (countEl) countEl.textContent = steps + (steps === 1 ? " step" : " steps");
  };

  const build = () => {
    if (ui || !document.body) return;
    ui = document.createElement("div");
    ui.id = UI_ID;
    ui.setAttribute("data-reel-ui", "1");
    ui.style.cssText = [
      "position:fixed", "z-index:2147483647", "left:50%", "bottom:20px",
      "transform:translateX(-50%)", "display:flex", "gap:8px", "align-items:center",
      "padding:8px 10px", "border-radius:999px", "background:rgba(16,16,20,.92)",
      "color:#fff", "font:500 13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "box-shadow:0 8px 30px rgba(0,0,0,.45)", "backdrop-filter:blur(8px)",
    ].join(";");

    const dot = document.createElement("span");
    dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#ff4d4f;box-shadow:0 0 0 4px rgba(255,77,79,.2)";
    ui.appendChild(dot);

    countEl = document.createElement("span");
    countEl.style.cssText = "opacity:.85;min-width:56px";
    ui.appendChild(countEl);

    const field = document.createElement("input");
    field.placeholder = "Add a caption…";
    field.style.cssText = "background:rgba(255,255,255,.1);border:0;border-radius:999px;color:#fff;padding:6px 12px;width:180px;outline:none;font:inherit";
    field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !field.value.trim()) return;
      steps++;
      send({ type: "caption", text: field.value.trim() });
      field.value = "";
      render();
    });
    ui.appendChild(field);

    const button = (label, background) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "border:0;border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit;color:#fff;background:" + background;
      ui.appendChild(b);
      return b;
    };

    // A beat is the one thing capture can't infer: which moment is the point.
    button("Beat", "rgba(255,255,255,.14)").addEventListener("click", () => {
      steps++;
      send({ type: "beat" });
      render();
    });

    button("Finish", "#6d8bff").addEventListener("click", () => send({ type: "finish" }));

    document.body.appendChild(ui);
    render();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
  // Survives client-side rendering that replaces the body wholesale.
  setInterval(() => { if (!document.getElementById(UI_ID)) { ui = null; build(); } }, 500);
})();
`;
