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
  type: "click" | "dblclick" | "drag" | "input" | "key" | "caption" | "say" | "mark" | "beat" | "finish";
  candidates?: { kind: string; selector: string; matches: number }[];
  /** Where a drag was released, when something nameable was under it. */
  toCandidates?: { kind: string; selector: string; matches: number }[];
  /** Where a drag was released, in viewport pixels — the fallback. */
  toPoint?: { x: number; y: number };
  /** Final value of a field, for input events. */
  value?: string;
  /** The key pressed, for key events. */
  key?: string;
  /** Caption or narration text, when the user annotates from the toolbar. */
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
  // Armed by the toolbar's Mark button; consumed by the next click on the page.
  let marking = false;

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

  /**
   * Roles whose accessible name may come from the text inside them.
   *
   * ARIA is explicit about this and the difference is not cosmetic: a group,
   * a region or a dialog full of text has *no* accessible name unless the
   * author labelled it. Taking the text anyway produces a selector that looks
   * exactly right, passes the uniqueness check in this page, and resolves to
   * nothing at all in Playwright — n8n's canvas offers a role=group reading
   * "Add first step…", and the captured spec failed on its first replay.
   */
  var NAME_FROM_CONTENT = ["button","cell","checkbox","columnheader","gridcell",
    "heading","link","menuitem","menuitemcheckbox","menuitemradio","option","radio",
    "row","rowheader","switch","tab","tooltip","treeitem"];

  const nameOf = (el, role) => {
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
    // A role that cannot be named by its content is named by the author or not
    // at all. A title attribute still counts — that is authored, not content.
    if (role !== undefined && NAME_FROM_CONTENT.indexOf(role) === -1) return norm(title);
    return norm(el.innerText || el.textContent) || norm(title);
  };

  /**
   * Every count takes the region to count in.
   *
   * A name that matches twice in the page usually matches once in the part of
   * the page it belongs to, and that is the difference between a selector and a
   * CSS path. The root is the document unless a caller is asking "how many, in
   * here?" — which is the whole of the scoping machinery below.
   */

  /** Elements matching a role+name pair, the way Playwright role= resolves. */
  const countRole = (role, name, root) => {
    const wanted = name.toLowerCase();
    let n = 0;
    for (const el of (root || document).querySelectorAll("*")) {
      if (roleOf(el) !== role) continue;
      if (name && nameOf(el, role).toLowerCase() !== wanted) continue;
      n++;
    }
    return n;
  };

  /**
   * Playwright text= takes the smallest element containing the string, so a
   * parent that merely wraps the match is not another match.
   */
  const countText = (text, root) => {
    const wanted = text.toLowerCase();
    let n = 0;
    for (const el of (root || document).querySelectorAll("*")) {
      if (!norm(el.textContent).toLowerCase().includes(wanted)) continue;
      let deeper = false;
      for (const child of el.children) {
        if (norm(child.textContent).toLowerCase().includes(wanted)) { deeper = true; break; }
      }
      if (!deeper) n++;
    }
    return n;
  };

  const countCss = (selector, root) => {
    try { return (root || document).querySelectorAll(selector).length; } catch { return 0; }
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

  /**
   * Regions a page is already divided into, in the app's own terms.
   *
   * Scoping is only worth doing to a container the app itself treats as one —
   * a nav, a dialog, a row. An arbitrary wrapper div would be the CSS path
   * problem again with extra steps, so those are not on the list.
   */
  const CONTAINERS = "main,nav,header,footer,aside,form,dialog,section,article,li,tr," +
    "[role=navigation],[role=main],[role=banner],[role=contentinfo],[role=complementary]," +
    "[role=dialog],[role=search],[role=form],[role=region],[role=listitem],[role=row]," +
    "[role=tabpanel],[role=menu],[role=toolbar]";

  /**
   * A selector for the region itself, which must be unique on its own terms.
   *
   * If it takes an nth-of-type to say which nav, the scope is no more stable
   * than the path it was meant to replace — better to report the ambiguity.
   */
  const scopeSelector = (el) => {
    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) {
        const sel = "[" + attr + '="' + value.replace(/"/g, '\\\\"') + '"]';
        if (countCss(sel) === 1) return sel;
      }
    }
    // Only a plain id: one that needs escaping buys ambiguity, and Node checks
    // whether it looks generated, which it can only do on the raw text.
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && countCss("#" + el.id) === 1) return "#" + el.id;
    const tag = el.tagName.toLowerCase();
    if (countCss(tag) === 1) return tag;
    const role = el.getAttribute("role");
    if (role && countCss("[role=" + role + "]") === 1) return "[role=" + role + "]";
    return "";
  };

  const candidatesFor = (el) => {
    const out = [];
    /** count(root) answers "how many in here?", for the scoping pass below. */
    const add = (kind, selector, count) => {
      out.push({ kind: kind, selector: selector, matches: count(document), count: count });
    };

    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) {
        const sel = "[" + attr + '="' + value.replace(/"/g, '\\\\"') + '"]';
        add("testid", sel, (root) => countCss(sel, root));
        break;
      }
    }

    if (el.id) add("id", "#" + el.id, (root) => countCss("#" + CSS.escape(el.id), root));

    const role = roleOf(el);
    const name = nameOf(el, role);
    if (role && name) {
      const quoted = /[\\s\\]"']/.test(name) ? JSON.stringify(name) : name;
      add("role", "role=" + role + "[name=" + quoted + "]", (root) => countRole(role, name, root));
    } else if (role) {
      add("role", "role=" + role, (root) => countRole(role, "", root));
    }

    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    if (placeholder) {
      const sel = '[placeholder="' + placeholder.replace(/"/g, '\\\\"') + '"]';
      add("placeholder", sel, (root) => countCss(sel, root));
    }

    const text = norm(el.innerText || el.textContent);
    if (text) add("text", "text=" + text, (root) => countText(text, root));

    const path = cssPath(el);
    if (path) add("css", path, (root) => countCss(path, root));

    /*
     * A name that matches twice is not a bad name — it is a name that has not
     * said which part of the page it means. A docs site has a Tutorial link in
     * the nav and another in the hero; discarding both leaves a CSS path, while
     * "the Tutorial link in the nav" is exactly what the person meant and stays
     * true through a redesign of either one.
     *
     * The nearest region that makes the name unique wins, so the scope stays as
     * small as the ambiguity requires.
     */
    const ambiguous = out.filter((c) => c.matches > 1 && c.kind !== "css");
    for (let node = el.parentElement; node && ambiguous.length; node = node.parentElement) {
      if (!node.matches || !node.matches(CONTAINERS)) continue;
      const scope = scopeSelector(node);
      if (!scope) continue;
      const resolved = ambiguous.filter((c) => c.count(node) === 1);
      for (const c of resolved) out.push({ kind: "scoped", selector: scope + " >> " + c.selector, matches: 1 });
      if (resolved.length) break;
    }

    // The counters are closures over the page; only the reading travels.
    return out.map((c) => ({ kind: c.kind, selector: c.selector, matches: c.matches }));
  };

  const ours = (node) => !!(node && node.closest && node.closest("#" + UI_ID));

  /**
   * The thing that was actually clicked, rather than the node under the cursor.
   *
   * A click on an icon button reports the <path> inside its <svg>; a click on a
   * label inside a link reports the <span>. Neither has a role, a name or any
   * text, so both fall through to a CSS path — which is how a theme toggle came
   * out as div > button > svg:nth-of-type(3) > path. The element a person
   * means is the nearest one that can be interacted with.
   */
  const ACTIONABLE = "a[href],button,input,select,textarea,label,summary,[role=button]," +
    "[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[onclick],[tabindex]";
  const actionable = (el) => {
    if (!el || !el.closest) return el;
    // SVG elements support closest() too, so this walks out of the icon.
    return el.closest(ACTIONABLE) || el;
  };

  /** The field currently being typed into, so a run of keystrokes counts once. */
  let lastTyped = null;

  /**
   * A drag looks like nothing at all unless you watch for it.
   *
   * Press and release on different elements, and the browser fires no click —
   * so a card dragged between columns produced no event, no step, and nothing
   * in the skipped list either. The demo silently lost the one thing it was
   * about.
   *
   * Distance is what separates the two gestures: a press and release in the
   * same place is a click however long it took, and a press that travelled is a
   * drag however quickly. Small movements are somebody's hand, not an
   * intention.
   */
  const DRAG_THRESHOLD_PX = 12;
  let press = null;

  document.addEventListener("pointerdown", (e) => {
    const el = actionable(e.target);
    press = el && !ours(el) ? { el: el, x: e.clientX, y: e.clientY } : null;
  }, true);

  document.addEventListener("pointerup", (e) => {
    const from = press;
    press = null;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return; // a click; that handler has it

    // What is under the cursor at the release, which is not where the press
    // was — the dragged element usually follows the pointer and would name
    // itself as its own destination.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under && !from.el.contains(under) ? actionable(under) : null;
    lastTyped = null;
    steps++;
    render();
    send({
      type: "drag",
      candidates: candidatesFor(from.el),
      toCandidates: target ? candidatesFor(target) : undefined,
      toPoint: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
      url: location.href,
    });
  }, true);

  document.addEventListener("click", (e) => {
    const el = actionable(e.target);
    if (!el || ours(el)) return;
    // Marking is pointing, not pressing. The click is swallowed so the app does
    // not act on it: the user is naming an element for a highlight, and a demo
    // that submitted the form while you annotated it would be recording
    // something you did not do.
    if (marking) {
      e.preventDefault();
      e.stopPropagation();
      marking = false;
      steps++;
      render();
      send({ type: "mark", candidates: candidatesFor(el), url: location.href });
      return;
    }
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
    send({ type: "key", key: parts.join("+"), candidates: candidatesFor(actionable(e.target)), url: location.href });
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

    const line = document.createElement("input");
    line.placeholder = "Narrate…";
    line.style.cssText = "background:rgba(255,255,255,.1);border:0;border-radius:999px;color:#fff;padding:6px 12px;width:180px;outline:none;font:inherit";
    line.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !line.value.trim()) return;
      steps++;
      send({ type: "say", text: line.value.trim() });
      line.value = "";
      render();
    });
    ui.appendChild(line);

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

    // Pointing at an element is not a UI-only idea — this is the same gesture
    // Studio would offer, reachable from the command line, writing the same
    // selector into the same spec.
    const mark = button("Mark", "rgba(255,255,255,.14)");
    mark.addEventListener("click", () => {
      marking = !marking;
      mark.style.background = marking ? "#6d8bff" : "rgba(255,255,255,.14)";
      mark.textContent = marking ? "Click an element…" : "Mark";
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
