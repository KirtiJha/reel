/**
 * Scene templates — the parts of a demo that are not the app.
 *
 * A title card, a chapter opener, a claim, a short list. None of it is
 * footage: it is motion graphics, and until now Reel drew it as a flex `div`
 * with two lines of text, because everything else in the render path composites
 * with sharp and sharp cannot lay out a paragraph.
 *
 * These are HTML instead. The browser is already open, so CSS does the layout,
 * the wrapping, the fonts and the gradients — and the entrance animation is a
 * pure function of the seek position rather than a clock, which is what keeps
 * two renders byte-identical.
 *
 * Nothing here animates with CSS `animation` or `transition`. It cannot: the
 * determinism layer suppresses both inside every document, deliberately. Every
 * moving value reads `--in` or `--out`, which Reel recomputes per frame.
 */

export interface SceneStyle {
  /** The spec's accent, so a scene looks like the rest of the demo. */
  accent: string;
  /** The spec's background — a colour or a gradient. */
  background: string;
  /** `dark` or `light`; picks the text colours. */
  theme: string;
}

export interface SceneFields {
  title?: string;
  subtitle?: string;
  /** For `chapter`: the number or short label above the title. */
  eyebrow?: string;
  /** For `bullets`: the lines, revealed in sequence. */
  items?: string[];
  /** For `statement`: who said it. */
  attribution?: string;
}

export const TEMPLATES = ["title", "chapter", "statement", "bullets"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

const FONT =
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/**
 * The body of a scene document for one of the built-in templates.
 *
 * Returns `<style>` plus markup. The caller wraps it with the seek runtime,
 * which is what supplies `--in` and `--out`.
 */
export function renderTemplate(
  name: TemplateName,
  fields: SceneFields,
  style: SceneStyle,
): string {
  const light = style.theme === "light";
  const ink = light ? "#0d1017" : "#ffffff";
  const muted = light ? "rgba(13,16,23,.62)" : "rgba(255,255,255,.66)";

  const base = `
    :root { --p: 0; --in: 0; --out: 1; }
    * { box-sizing: border-box; margin: 0; }
    html, body { height: 100%; }
    body {
      display: flex; align-items: center; justify-content: center;
      padding: 7vh 8vw; text-align: center;
      font-family: ${FONT}; color: ${ink};
      background: ${escapeCss(style.background)};
      /* The whole scene fades with --out, so a scene can leave as well as arrive. */
      opacity: var(--out);
    }
    .stack { display: flex; flex-direction: column; align-items: center; gap: 2.2vh; width: 100%; }
    /* Entrances read --in. Nothing here uses transition or animation, because
       the determinism layer suppresses both and a clock-driven entrance would
       not survive being seeked. */
    .rise {
      opacity: var(--in);
      transform: translateY(calc((1 - var(--in)) * 2.2vh));
    }
    .rule {
      height: 3px; border-radius: 2px; background: ${escapeCss(style.accent)};
      width: calc(var(--in) * 9vw);
    }
    .title { font-size: clamp(30px, 5.6vw, 78px); font-weight: 700; letter-spacing: -.02em; line-height: 1.08; }
    .sub { font-size: clamp(15px, 2.1vw, 26px); font-weight: 400; line-height: 1.45; color: ${muted}; max-width: 46ch; }
  `;

  switch (name) {
    case "chapter": {
      // The eyebrow arrives first and the title follows, so the eye lands on
      // the number and then reads. A simultaneous entrance reads as a jump cut.
      return `<style>${base}
        .eyebrow {
          font-size: clamp(12px, 1.5vw, 18px); font-weight: 600; letter-spacing: .18em;
          text-transform: uppercase; color: ${escapeCss(style.accent)};
          opacity: var(--in);
        }
        .chapter-title { transform: translateY(calc((1 - var(--in)) * 3.4vh)); opacity: var(--in); }
      </style>
      <div class="stack">
        ${fields.eyebrow ? `<div class="eyebrow">${esc(fields.eyebrow)}</div>` : ""}
        <div class="title chapter-title">${esc(fields.title ?? "")}</div>
        <div class="rule"></div>
        ${fields.subtitle ? `<div class="sub rise">${esc(fields.subtitle)}</div>` : ""}
      </div>`;
    }

    case "statement": {
      return `<style>${base}
        .quote {
          font-size: clamp(24px, 4.2vw, 56px); font-weight: 600; line-height: 1.22;
          letter-spacing: -.015em; max-width: 22ch;
          opacity: var(--in); transform: translateY(calc((1 - var(--in)) * 2.6vh));
        }
        .mark { color: ${escapeCss(style.accent)}; }
        .attrib { font-size: clamp(13px, 1.6vw, 19px); color: ${muted}; opacity: var(--in); }
      </style>
      <div class="stack">
        <div class="quote"><span class="mark">“</span>${esc(fields.title ?? "")}<span class="mark">”</span></div>
        ${fields.attribution ? `<div class="attrib rise">${esc(fields.attribution)}</div>` : ""}
      </div>`;
    }

    case "bullets": {
      const items = fields.items ?? [];
      // Staggered: each line has its own slice of --in, so the list builds
      // rather than appearing at once. That is the difference between a slide
      // and a moment.
      const lis = items
        .map((item, i) => {
          const start = items.length > 1 ? (i / items.length) * 0.72 : 0;
          const span = 1 - start || 1;
          return `<li style="--t: calc(min(1, max(0, (var(--in) - ${start.toFixed(3)}) / ${span.toFixed(3)})))">
            <span class="dot"></span><span class="text">${esc(item)}</span>
          </li>`;
        })
        .join("");
      return `<style>${base}
        body { text-align: left; }
        .stack { align-items: flex-start; }
        ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 1.8vh; width: 100%; }
        li {
          display: flex; align-items: baseline; gap: 1.4vw;
          font-size: clamp(17px, 2.6vw, 34px); font-weight: 500; line-height: 1.3;
          opacity: var(--t); transform: translateX(calc((1 - var(--t)) * -1.6vw));
        }
        .dot { flex: none; width: .62em; height: .62em; border-radius: 50%; background: ${escapeCss(style.accent)}; }
      </style>
      <div class="stack">
        ${fields.title ? `<div class="title" style="font-size: clamp(22px,3.4vw,44px); opacity: var(--in)">${esc(fields.title)}</div>` : ""}
        <ul>${lis}</ul>
      </div>`;
    }

    case "title":
    default:
      return `<style>${base}</style>
      <div class="stack">
        <div class="title rise">${esc(fields.title ?? "")}</div>
        <div class="rule"></div>
        ${fields.subtitle ? `<div class="sub rise">${esc(fields.subtitle)}</div>` : ""}
      </div>`;
  }
}

/** Text going into markup. A demo title is author-supplied, not trusted markup. */
export function esc(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * A colour or gradient going into a CSS declaration.
 *
 * `background` comes from the spec, and a value containing `;` or `}` would
 * close the declaration and open a new rule. Stripping those is what keeps a
 * spec from writing arbitrary CSS into a scene — which matters because a spec
 * is often reviewed less carefully than code.
 */
export function escapeCss(v: string): string {
  return v.replace(/[;}{<]/g, "").trim();
}
