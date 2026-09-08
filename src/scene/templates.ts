/**
 * Scene templates — the parts of a demo that are not the app.
 *
 * A title card, a chapter opener, a claim, a short list. None of it is
 * footage: it is motion graphics, and until recently Reel drew it as a flex
 * `div` with two lines of text, because everything else in the render path
 * composites with sharp and sharp cannot lay out a paragraph.
 *
 * ## What a template is, and what it is not
 *
 * A template here is *layout only* — where the eyebrow sits relative to the
 * title, whether the list is centred, which fields exist. It has no colours, no
 * backdrop and no opinion about type. All of that belongs to the **look**
 * (`looks.ts`), so `look: swiss` and `look: neon` are the same four templates
 * wearing different films.
 *
 * That split is the lesson from HyperFrames, which ships no templates at all:
 * bake one backdrop into the framework and every demo it renders opens on the
 * same picture. Templates are the fast path. When a demo deserves something
 * nobody anticipated, `scene: { file: … }` takes a composition written for that
 * one demo, and the `reel-scene` skill teaches an agent how to write it.
 *
 * ## The constraint that shapes all of it
 *
 * Nothing here animates with CSS `animation` or `transition`. It cannot: the
 * determinism layer suppresses both inside every document, deliberately, so an
 * app's own motion cannot make two renders differ. Every moving value instead
 * reads a custom property Reel rewrites per frame — `--in` and `--out` for
 * arrival and departure, `--p` for raw progress through the scene. There is no
 * clock, which is a stronger guarantee than freezing one.
 */

import {
  DEFAULT_LOOK,
  entranceCss,
  lookFor,
  type LookName,
} from "./looks.js";

export interface SceneStyle {
  /**
   * The spec's accent, so a scene looks like the rest of the demo.
   *
   * Every look builds its backdrop out of this one colour, which is why the
   * same look on two products does not produce the same picture.
   */
  accent: string;
  /**
   * Which visual identity to draw in. See `looks.ts`.
   *
   * The look owns the ground, the ink and the type — deliberately, and in
   * preference to `polish.background`, which is the *film's* ground rather than
   * a scene's. A demo that needs a specific colour behind a specific scene has
   * outgrown templates and wants `scene: { file: … }`.
   */
  look?: LookName;
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
  /** Corner slate, top line — letter-spaced caps, e.g. `03 · Chapter`. */
  slate?: string;
  /** Corner slate, second line — e.g. the product or a URL. */
  slateNote?: string;
}

export const TEMPLATES = ["title", "chapter", "statement", "bullets"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/**
 * How long a word takes to arrive, as a fraction of the entrance.
 *
 * Words overlap heavily. A stagger where each word finished before the next
 * began would take the whole scene to read one line — the effect wanted is a
 * ripple, not a typewriter.
 */
const WORD_SPAN = 0.55;

/**
 * The body of a scene document for one of the built-in templates.
 *
 * Returns `<style>` plus markup. The caller wraps it with the seek runtime,
 * which is what supplies `--p`, `--in` and `--out`.
 */
export function renderTemplate(
  name: TemplateName,
  fields: SceneFields,
  style: SceneStyle,
): string {
  const look = lookFor(style.look ?? DEFAULT_LOOK);
  const accent = escapeCss(style.accent);
  const backdrop = look.backdrop(accent);

  const ink = look.ink;
  const muted = look.muted;
  // Bloom is a look's property, not a template's: an editorial look wants none,
  // and multiplying by zero is how it gets none without a second code path.
  const glow = (px: number) => `0 0 calc(var(--in) * ${Math.round(px * look.bloom)}px)`;

  const base = `
    :root { --p: 0; --in: 0; --out: 1; }
    * { box-sizing: border-box; margin: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      position: relative;
      display: flex; align-items: center; justify-content: center;
      padding: 9vh 9vw; text-align: center;
      font-family: ${look.display}; color: ${ink};
      background: ${look.ground};
      opacity: var(--out);
    }
    /* The backdrop layers are <i> so a look can add as many as it likes without
       the template knowing how many there are. */
    body > i { display: block; }

${backdrop.css}

${plateCss(look.plate, look.dark)}

    /* --- the slate ------------------------------------------------------
       A numbered label in letter-spaced caps against a hairline rule, pinned to
       a corner and held for the whole scene. It costs almost nothing and it is
       most of why a frame reads as produced rather than presented. */
    .slate {
      position: absolute; top: 6vh; left: 6vw; text-align: left;
      padding-left: 1.1vw; border-left: 2px solid ${accent};
      opacity: var(--in);
      transform: translateX(calc((1 - var(--in)) * -1vw));
    }
    .slate .k {
      font-family: ${look.label}; font-size: clamp(9px, 1.05vw, 14px);
      letter-spacing: .26em; text-transform: uppercase; color: ${muted};
    }
    .slate .n {
      font-size: clamp(15px, 1.9vw, 26px); font-weight: 650;
      letter-spacing: -.01em; color: ${ink}; margin-top: .25em;
    }

    .stack {
      position: relative; z-index: 1;
      display: flex; flex-direction: column; align-items: center;
      gap: 2.4vh; width: 100%;
    }

    /* --- type ----------------------------------------------------------- */
    .title {
      font-size: clamp(34px, 7.2vw, 104px);
      font-weight: ${look.displayWeight};
      letter-spacing: ${look.tracking};
      text-transform: ${look.transform};
      line-height: 1.02;
      text-shadow: ${glow(46)} ${accent}55;
    }
    /* A word arrives on its own slice of --in. Which motion that is belongs to
       the look — a mask for the typeset ones, a clearing blur for the loud
       ones — so the same title reads differently in each without the template
       branching. */
    .w { display: inline-block; ${entranceCss(look.entrance)} }
    .rule {
      height: 3px; border-radius: 2px; background: ${accent};
      width: calc(var(--in) * 10vw);
      box-shadow: ${glow(22)} ${accent};
    }
    .sub {
      font-family: ${look.display};
      font-size: clamp(15px, 2.2vw, 28px); font-weight: 400; line-height: 1.45;
      color: ${muted}; max-width: 44ch; letter-spacing: 0; text-transform: none;
      opacity: var(--in); transform: translateY(calc((1 - var(--in)) * 1.4vh));
    }
  `;

  const layers = backdrop.markup + plateMarkup(look.plate);
  const slate = slateMarkup(fields);

  switch (name) {
    case "chapter": {
      return `<style>${base}
        .eyebrow {
          font-family: ${look.label}; font-size: clamp(11px, 1.35vw, 17px); font-weight: 600;
          letter-spacing: .3em; text-transform: uppercase; color: ${accent};
          opacity: var(--in); text-shadow: ${glow(26)} ${accent};
        }
      </style>
      ${layers}${slate}
      <div class="stack">
        ${fields.eyebrow ? `<div class="eyebrow">${esc(fields.eyebrow)}</div>` : ""}
        <div class="title">${words(fields.title ?? "")}</div>
        <div class="rule"></div>
        ${fields.subtitle ? `<div class="sub">${esc(fields.subtitle)}</div>` : ""}
      </div>`;
    }

    case "statement": {
      return `<style>${base}
        .quote {
          font-size: clamp(26px, 5.2vw, 68px); font-weight: ${look.displayWeight};
          line-height: 1.16; letter-spacing: ${look.tracking};
          text-transform: ${look.transform}; max-width: 20ch;
          text-shadow: ${glow(40)} ${accent}55;
        }
        .mark { color: ${accent}; text-shadow: ${glow(30)} ${accent}; }
        .attrib {
          font-family: ${look.label}; font-size: clamp(11px, 1.4vw, 17px);
          letter-spacing: .22em; text-transform: uppercase; color: ${muted};
          opacity: var(--in);
        }
      </style>
      ${layers}${slate}
      <div class="stack">
        <div class="quote"><span class="mark">“</span>${words(fields.title ?? "")}<span class="mark">”</span></div>
        ${fields.attribution ? `<div class="attrib">${esc(fields.attribution)}</div>` : ""}
      </div>`;
    }

    case "bullets": {
      const items = fields.items ?? [];
      const lis = items
        .map((item, i) => {
          const start = items.length > 1 ? (i / items.length) * 0.66 : 0;
          const span = 1 - start || 1;
          return `<li style="--t: ${slice(start, span)}">
            <span class="dot"></span><span>${esc(item)}</span>
          </li>`;
        })
        .join("");
      return `<style>${base}
        body { text-align: left; }
        .stack { align-items: flex-start; }
        ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 2.1vh; width: 100%; }
        li {
          display: flex; align-items: baseline; gap: 1.5vw;
          font-size: clamp(19px, 3.1vw, 42px); font-weight: 600; line-height: 1.24;
          letter-spacing: -.02em;
          ${entranceCss(look.entrance)}
        }
        .dot {
          flex: none; width: .5em; height: .5em; border-radius: 50%; background: ${accent};
          box-shadow: ${glow(20)} ${accent};
        }
        .lead { font-size: clamp(20px, 3.2vw, 40px); }
      </style>
      ${layers}${slate}
      <div class="stack">
        ${fields.title ? `<div class="title lead">${words(fields.title)}</div>` : ""}
        <ul>${lis}</ul>
      </div>`;
    }

    case "title":
    default:
      return `<style>${base}</style>
      ${layers}${slate}
      <div class="stack">
        <div class="title">${words(fields.title ?? "")}</div>
        <div class="rule"></div>
        ${fields.subtitle ? `<div class="sub">${esc(fields.subtitle)}</div>` : ""}
      </div>`;
  }
}

/**
 * The well the type sits in.
 *
 * A loud backdrop and a title are in direct competition, and the title has to
 * win. Looks that are quiet enough not to need one declare `plate: 0` and get
 * no element at all rather than a transparent one.
 */
function plateCss(strength: number, dark: boolean): string {
  if (strength <= 0) return "";
  const c = (a: number) =>
    dark ? `rgba(0,0,0,${(a * strength).toFixed(3)})` : `rgba(255,255,255,${(a * strength).toFixed(3)})`;
  return `
    .plate {
      position: absolute; inset: 6% 2%; pointer-events: none;
      background: radial-gradient(ellipse at 50% 48%,
        ${c(1)} 0%, ${c(0.85)} 34%, ${c(0.42)} 58%, transparent 78%);
      opacity: var(--in);
    }`;
}

function plateMarkup(strength: number): string {
  return strength > 0 ? `<i class="plate"></i>` : "";
}

/** The corner slate, when the scene asked for one. */
function slateMarkup(fields: SceneFields): string {
  if (!fields.slate && !fields.slateNote) return "";
  return (
    `<div class="slate">` +
    (fields.slate ? `<div class="k">${esc(fields.slate)}</div>` : "") +
    (fields.slateNote ? `<div class="n">${esc(fields.slateNote)}</div>` : "") +
    `</div>`
  );
}

/** One element's slice of `--in`, clamped to 0–1. */
function slice(start: number, span: number): string {
  return `calc(min(1, max(0, (var(--in) - ${start.toFixed(3)}) / ${span.toFixed(3)})))`;
}

/**
 * A line split into per-word spans, each on its own slice of `--in`.
 *
 * The slices overlap: word *i* starts at `i/n * WORD_SPAN`, so a six-word title
 * is fully in by the end of the entrance rather than still arriving halfway
 * through the scene. Spacing comes from real spaces between the spans, so the
 * line still wraps the way the browser would wrap it.
 */
export function words(text: string): string {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  return parts
    .map((word, i) => {
      const start = parts.length > 1 ? (i / parts.length) * WORD_SPAN : 0;
      const span = 1 - start || 1;
      return `<span class="w" style="--t: ${slice(start, span)}">${esc(word)}</span>`;
    })
    .join(" ");
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
 * `accent` comes from the spec, and a value containing `;` or `}` would close
 * the declaration and open a new rule. Stripping those is what keeps a spec
 * from writing arbitrary CSS into a scene — which matters because a spec is
 * often reviewed less carefully than code.
 */
export function escapeCss(v: string): string {
  return v.replace(/[;}{<]/g, "").trim();
}
