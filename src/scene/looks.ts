/**
 * Looks — named visual identities a scene can be drawn in.
 *
 * ## Why this exists
 *
 * The first version of `templates.ts` hard-coded one backdrop, and it was a
 * good backdrop, which made it worse rather than better: every demo Reel has
 * ever rendered would have opened on the same concentric rings. A tool that
 * produces one look does not produce a look at all — it produces a watermark.
 *
 * HyperFrames solves this by not shipping templates. Its engine guarantees
 * determinism and nothing else; an agent writes bespoke HTML per project,
 * steered by a library of named design languages. Reel takes both halves. This
 * file is the first half: the design languages, as *data*, so a spec picks one
 * with a word and the whole film changes. `scene: { file: … }` plus the
 * `reel-scene` skill is the second half, for when a demo deserves something
 * nobody anticipated.
 *
 * ## What a look owns, and what it does not
 *
 * A look owns the ground, the ink, the backdrop, the type and how words
 * arrive. It does *not* own the accent: that comes from the spec, so a demo
 * stays on-brand no matter which look it is cut in. Every backdrop here is
 * built from that one accent — hue-rotated, tinted, repeated — which is why
 * `look: neon` on a green product looks like that product rather than like the
 * example in the docs.
 *
 * ## The constraint every look obeys
 *
 * No CSS `animation`, no `transition`. The determinism layer suppresses both
 * inside every document so an app's own motion cannot make two renders differ,
 * and a look that reached for either would simply not move. Motion is instead a
 * pure function of the seek position: `--p` is raw progress through the scene,
 * `--in` ramps 0→1 as it arrives, `--out` 1→0 as it leaves. A backdrop reads
 * `--p` so it drifts for the whole scene; type reads `--in` so it arrives once.
 */

export interface Backdrop {
  /** Rules for the layer classes, appended to the scene's stylesheet. */
  css: string;
  /** The layer elements themselves, in paint order. */
  markup: string;
}

/** How a word or a line arrives. Each is a pure function of `--t`. */
export type Entrance = "rise" | "mask" | "scale" | "blur" | "slide";

export interface Look {
  name: LookName;
  /** One line: what it feels like, and what it is for. */
  mood: string;
  /** Dark grounds get light ink. Drives the vignette and plate polarity too. */
  dark: boolean;
  /** The page behind everything. A colour or a gradient. */
  ground: string;
  /** Primary text. */
  ink: string;
  /** Secondary text — subtitles, attributions, the slate's top line. */
  muted: string;
  /** Font stack for display type. */
  display: string;
  /** Font stack for labels, slates and anything letter-spaced. */
  label: string;
  displayWeight: number;
  /** Tracking on display type. Tight for grotesques, loose for caps. */
  tracking: string;
  /** `uppercase` for looks whose display type is set in caps. */
  transform: string;
  /** How much glow the type carries, 0–1. Editorial looks want none. */
  bloom: number;
  /** How words arrive. */
  entrance: Entrance;
  /** Darkens (or lightens) the middle so type reads over a loud backdrop. */
  plate: number;
  /** The backdrop, built from the spec's accent. */
  backdrop: (accent: string) => Backdrop;
}

const SANS =
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`;
const SERIF = `ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif`;
const CONDENSED = `"Arial Narrow", "Helvetica Neue Condensed", "Liberation Sans Narrow", ${SANS}`;

/**
 * The catalogue.
 *
 * Each entry is grounded in a real graphic-design tradition rather than
 * invented, because a look assembled out of taste alone tends to land halfway
 * between two of these and read as neither.
 */
const CATALOGUE = {
  /**
   * Soft drifting colour fields on deep navy. The safe, handsome default:
   * flattering to almost any accent and quiet enough to put words on.
   */
  aurora: {
    mood: "Calm, premium, modern. The default when a demo has no strong opinion.",
    dark: true,
    ground: "#070a16",
    ink: "#ffffff",
    muted: "rgba(255,255,255,.66)",
    display: SANS,
    label: MONO,
    displayWeight: 800,
    tracking: "-.035em",
    transform: "none",
    bloom: 0.55,
    entrance: "rise",
    plate: 0.42,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="l1"></i><i class="l2"></i><i class="l3"></i>`,
      css: `
        .l1, .l2, .l3 { position: absolute; inset: -35%; pointer-events: none; }
        .l1 {
          background: radial-gradient(closest-side, ${a}, transparent 70%);
          width: 90%; height: 110%; inset: auto auto -20% -10%;
          filter: blur(60px) saturate(2.1);
          transform: translate(calc(var(--p) * 8vw), calc(var(--p) * -6vh)) scale(calc(1 + var(--p) * .2));
          opacity: calc(var(--in) * .92);
        }
        .l2 {
          background: radial-gradient(closest-side, ${a}, transparent 72%);
          width: 80%; height: 100%; inset: -25% -15% auto auto;
          filter: blur(70px) saturate(1.9) hue-rotate(calc(70deg + var(--p) * 50deg));
          transform: translate(calc(var(--p) * -6vw), calc(var(--p) * 5vh)) scale(calc(1.1 - var(--p) * .12));
          opacity: calc(var(--in) * .82);
        }
        .l3 {
          background: radial-gradient(closest-side, ${a}, transparent 68%);
          width: 60%; height: 70%; inset: 10% 20% auto auto;
          filter: blur(90px) saturate(1.8) hue-rotate(calc(-60deg - var(--p) * 40deg));
          transform: scale(calc(1 + var(--p) * .3));
          opacity: calc(var(--in) * .7);
        }`,
    }),
  },

  /**
   * Concentric saturated rings, additively blended into a spectrum. Loud on
   * purpose — this is the launch-film look, and it wants a short scene and a
   * few very large words.
   */
  neon: {
    mood: "Electric, kinetic, loud. Launch films and hero titles.",
    dark: true,
    ground: "#04040a",
    ink: "#ffffff",
    muted: "rgba(255,255,255,.72)",
    display: SANS,
    label: MONO,
    displayWeight: 800,
    tracking: "-.04em",
    transform: "none",
    bloom: 0.9,
    entrance: "blur",
    plate: 0.86,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="r1"></i><i class="r2"></i><i class="r3"></i>`,
      css: `
        /* A spec gives one accent, and CSS cannot rotate the hue of a single
           stop inside a gradient. Three ring layers at different periods, each
           hue-rotated a third of the wheel and screen-blended, mix into the
           full spectrum on the way out. */
        .r1, .r2, .r3 { position: absolute; inset: -25%; pointer-events: none; mix-blend-mode: screen; }
        .r1 {
          background: repeating-radial-gradient(circle at 50% 46%, ${a} 0 18px, transparent 18px 66px);
          filter: blur(4px) saturate(3) hue-rotate(calc(var(--p) * 80deg));
          transform: scale(calc(1 + var(--p) * .16));
          opacity: calc(var(--in) * .62);
        }
        .r2 {
          background: repeating-radial-gradient(circle at 50% 46%, transparent 0 34px, ${a} 34px 62px, transparent 62px 108px);
          filter: blur(6px) saturate(3) hue-rotate(calc(135deg + var(--p) * -70deg));
          transform: scale(calc(1.06 + var(--p) * .1));
          opacity: calc(var(--in) * .54);
        }
        .r3 {
          background: repeating-radial-gradient(circle at 50% 46%, transparent 0 74px, ${a} 74px 128px, transparent 128px 186px);
          filter: blur(11px) saturate(3) hue-rotate(calc(248deg + var(--p) * 110deg));
          transform: scale(calc(1.14 - var(--p) * .12));
          opacity: calc(var(--in) * .5);
        }`,
    }),
  },

  /**
   * Müller-Brockmann. An off-white ground, a visible grid, black grotesque type
   * and exactly one accent. Nothing glows; nothing is centred by accident.
   */
  swiss: {
    mood: "Clinical, precise, confident. Dev tools, data, anything technical.",
    dark: false,
    ground: "#f4f3ef",
    ink: "#101014",
    muted: "rgba(16,16,20,.56)",
    display: SANS,
    label: SANS,
    displayWeight: 700,
    tracking: "-.03em",
    transform: "none",
    bloom: 0,
    entrance: "mask",
    plate: 0,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="grid"></i><i class="bar"></i>`,
      css: `
        .grid {
          position: absolute; inset: 0; pointer-events: none;
          background:
            repeating-linear-gradient(to right, rgba(16,16,20,.09) 0 1px, transparent 1px 8.333%),
            repeating-linear-gradient(to bottom, rgba(16,16,20,.09) 0 1px, transparent 1px 12.5%);
          opacity: var(--in);
        }
        /* The one moving element, and it moves like a rule being drawn rather
           than like something arriving from off-screen. */
        .bar {
          position: absolute; left: 0; top: 0; height: .9vh; background: ${a};
          width: calc(var(--p) * 100%);
        }`,
    }),
  },

  /**
   * Cream stock, serif display, hairline rules, wide margins. The look of a
   * printed essay, which is the right register for a claim or a quote.
   */
  editorial: {
    mood: "Considered, literary, unhurried. Statements, quotes, chapter openers.",
    dark: false,
    ground: "#f7f4ec",
    ink: "#17150f",
    muted: "rgba(23,21,15,.55)",
    display: SERIF,
    label: SANS,
    displayWeight: 600,
    tracking: "-.015em",
    transform: "none",
    bloom: 0,
    entrance: "rise",
    plate: 0,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="rule-t"></i><i class="rule-b"></i><i class="tint"></i>`,
      css: `
        .rule-t, .rule-b {
          position: absolute; left: 6vw; right: 6vw; height: 1px;
          background: rgba(23,21,15,.28);
          transform: scaleX(var(--in)); transform-origin: left;
        }
        .rule-t { top: 5vh; }
        .rule-b { bottom: 5vh; transform-origin: right; }
        /* A breath of the accent in one corner — enough to belong to the brand,
           not enough to become a graphic. */
        .tint {
          position: absolute; inset: auto -10% -20% auto; width: 60%; height: 70%;
          background: radial-gradient(closest-side, ${a}, transparent 70%);
          filter: blur(80px); opacity: calc(var(--in) * .3);
          transform: scale(calc(1 + var(--p) * .16));
        }`,
    }),
  },

  /**
   * Flat saturated ground, enormous black type, hard-edged blocks. No blur
   * anywhere — every soft edge in this look is a bug.
   */
  brutal: {
    mood: "Blunt, physical, high-impact. Big announcements and single numbers.",
    dark: false,
    ground: "#efe9dd",
    ink: "#0a0a0a",
    muted: "rgba(10,10,10,.62)",
    display: SANS,
    label: MONO,
    displayWeight: 900,
    tracking: "-.05em",
    transform: "uppercase",
    bloom: 0,
    entrance: "slide",
    plate: 0,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="slab"></i><i class="edge"></i><i class="tick"></i>`,
      css: `
        /* A block that wipes across and stops. Sharp edges, no easing beyond
           what the runtime already applied to --in.

           It sits under the type rather than behind it: a half-frame block
           puts the title half on the accent and half on the ground, and no
           ink colour is legible on both. */
        .slab {
          position: absolute; inset: auto 0 0 0; height: 22%;
          width: calc(var(--in) * 100%);
          background: ${a};
        }
        .edge {
          position: absolute; inset: 0; pointer-events: none;
          border: 1.2vh solid #0a0a0a;
          clip-path: inset(0 calc((1 - var(--in)) * 100%) 0 0);
        }
        /* The one thing that keeps moving after the entrance, and it steps
           across the top like a register mark rather than easing anywhere. */
        .tick {
          position: absolute; top: 0; height: 1.2vh; width: 9vw; background: #0a0a0a;
          left: calc(var(--p) * 91%);
        }`,
    }),
  },

  /**
   * A phosphor terminal. Everything monospaced, a scanline field, and a block
   * cursor that steps rather than glides.
   */
  terminal: {
    mood: "Hacker, precise, in-the-machine. CLI demos and anything about code.",
    dark: true,
    ground: "#04070a",
    ink: "#d8ffe4",
    muted: "rgba(216,255,228,.5)",
    display: MONO,
    label: MONO,
    displayWeight: 700,
    tracking: "-.01em",
    transform: "none",
    bloom: 0.7,
    entrance: "mask",
    plate: 0.2,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="scan"></i><i class="glowfield"></i>`,
      css: `
        .scan {
          position: absolute; inset: 0; pointer-events: none;
          background: repeating-linear-gradient(to bottom, rgba(255,255,255,.055) 0 1px, transparent 1px 3px);
          /* Drifts by a single scanline over the scene, which reads as a signal
             rather than as an animation. */
          transform: translateY(calc(var(--p) * 3px));
          opacity: var(--in);
        }
        .glowfield {
          position: absolute; inset: -20%; pointer-events: none;
          background: radial-gradient(ellipse at 50% 52%, ${a}, transparent 62%);
          filter: blur(70px); opacity: calc(var(--in) * .42);
          transform: scale(calc(1 + var(--p) * .12));
        }`,
    }),
  },

  /**
   * Drafting paper. A fine technical grid, crosshairs, and thin accent rules
   * that extend as the scene runs, like a drawing being dimensioned.
   */
  blueprint: {
    mood: "Technical, exacting, architectural. Architecture diagrams and specs.",
    dark: true,
    ground: "#061024",
    ink: "#eaf2ff",
    muted: "rgba(234,242,255,.56)",
    display: SANS,
    label: MONO,
    displayWeight: 700,
    tracking: "-.02em",
    transform: "none",
    bloom: 0.25,
    entrance: "scale",
    plate: 0.35,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="fine"></i><i class="coarse"></i><i class="cross-v"></i><i class="cross-h"></i>`,
      css: `
        .fine, .coarse { position: absolute; inset: 0; pointer-events: none; opacity: var(--in); }
        .fine {
          background:
            repeating-linear-gradient(to right, rgba(160,200,255,.1) 0 1px, transparent 1px 24px),
            repeating-linear-gradient(to bottom, rgba(160,200,255,.1) 0 1px, transparent 1px 24px);
        }
        .coarse {
          background:
            repeating-linear-gradient(to right, rgba(160,200,255,.2) 0 1px, transparent 1px 120px),
            repeating-linear-gradient(to bottom, rgba(160,200,255,.2) 0 1px, transparent 1px 120px);
          transform: translate(calc(var(--p) * 12px), calc(var(--p) * 8px));
        }
        /* Dimension lines drawing themselves across the frame. */
        .cross-v, .cross-h { position: absolute; background: ${a}; opacity: .8; }
        .cross-v { left: 14vw; top: 0; width: 1px; height: calc(var(--p) * 100%); }
        .cross-h { top: 18vh; left: 0; height: 1px; width: calc(var(--p) * 100%); }`,
    }),
  },

  /**
   * Swiss-poster descendant: giant condensed caps, a diagonal accent field
   * sweeping behind them.
   */
  poster: {
    mood: "Bold, graphic, festival-poster. Chapter openers and section breaks.",
    dark: true,
    ground: "#0d0b12",
    ink: "#ffffff",
    muted: "rgba(255,255,255,.6)",
    // Condensed first for the machines that have it, but the identity survives
    // without it: the weight, the caps and the tracking are doing the work, so a
    // Linux renderer gets the same poster in a wider face rather than a
    // different look entirely.
    display: CONDENSED,
    label: MONO,
    displayWeight: 800,
    tracking: "-.01em",
    transform: "uppercase",
    bloom: 0.2,
    entrance: "mask",
    plate: 0.25,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="sweep"></i><i class="stripes"></i>`,
      css: `
        .sweep {
          position: absolute; inset: -40%; pointer-events: none;
          background: linear-gradient(115deg, transparent 30%, ${a} 50%, transparent 70%);
          filter: saturate(1.6);
          transform: translateX(calc(-30% + var(--p) * 60%)) rotate(-8deg);
          opacity: calc(var(--in) * .55);
        }
        .stripes {
          position: absolute; inset: -20%; pointer-events: none;
          background: repeating-linear-gradient(115deg, ${a} 0 2px, transparent 2px 42px);
          opacity: calc(var(--in) * .22);
          transform: translateX(calc(var(--p) * -4vw));
        }`,
    }),
  },

  /**
   * Greyscale, high contrast, one hairline of colour. The look for a demo whose
   * product is already loud enough.
   */
  mono: {
    mood: "Restrained, serious, expensive. When the app itself is the colour.",
    dark: true,
    ground: "#0b0b0c",
    ink: "#fafafa",
    muted: "rgba(250,250,250,.5)",
    display: SANS,
    label: MONO,
    displayWeight: 700,
    tracking: "-.03em",
    transform: "none",
    bloom: 0,
    entrance: "rise",
    plate: 0.1,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="wash"></i><i class="hair"></i>`,
      css: `
        .wash {
          position: absolute; inset: -30%; pointer-events: none;
          background: radial-gradient(ellipse at 50% 40%, rgba(255,255,255,.09), transparent 60%);
          transform: scale(calc(1 + var(--p) * .12));
          opacity: var(--in);
        }
        .hair {
          position: absolute; left: 8vw; bottom: 8vh; height: 2px; background: ${a};
          width: calc(var(--in) * 14vw);
        }`,
    }),
  },

  /**
   * Warm gradient stock, dark ink, soft round shapes. The friendly end of the
   * catalogue — consumer products, onboarding, anything that should feel easy.
   */
  dawn: {
    mood: "Warm, friendly, optimistic. Consumer apps and onboarding.",
    dark: false,
    ground: "linear-gradient(160deg, #ffe9d6 0%, #ffd9d0 46%, #f6c9d8 100%)",
    ink: "#2a1420",
    muted: "rgba(42,20,32,.58)",
    display: SANS,
    label: SANS,
    displayWeight: 800,
    tracking: "-.035em",
    transform: "none",
    bloom: 0,
    entrance: "scale",
    plate: 0,
    backdrop: (a: string): Backdrop => ({
      markup: `<i class="b1"></i><i class="b2"></i>`,
      css: `
        .b1, .b2 { position: absolute; border-radius: 50%; pointer-events: none; filter: blur(40px); }
        .b1 {
          width: 46vw; height: 46vw; left: -10vw; bottom: -14vw;
          background: ${a}; opacity: calc(var(--in) * .34);
          transform: translateY(calc(var(--p) * -4vh)) scale(calc(1 + var(--p) * .14));
        }
        .b2 {
          width: 34vw; height: 34vw; right: -6vw; top: -10vw;
          background: ${a}; opacity: calc(var(--in) * .26);
          filter: blur(50px) hue-rotate(calc(40deg + var(--p) * 40deg));
          transform: scale(calc(1.1 - var(--p) * .1));
        }`,
    }),
  },
} satisfies Record<string, Omit<Look, "name">>;

export type LookName = keyof typeof CATALOGUE;

/** Every look, in the order they should be offered. */
export const LOOK_NAMES = Object.keys(CATALOGUE) as LookName[];

/** What a scene is drawn in when nothing says otherwise. */
export const DEFAULT_LOOK: LookName = "aurora";

/** Is this a look Reel ships? */
export function isLook(name: string): name is LookName {
  return Object.hasOwn(CATALOGUE, name);
}

/** The named look. */
export function lookFor(name: LookName): Look {
  return { name, ...CATALOGUE[name] };
}

/**
 * How a word arrives, as CSS reading `--t` — the word's own slice of `--in`.
 *
 * Every one of these is a pure function of `--t` with no clock and no keyframes,
 * which is the whole reason a scene can be seeked to an arbitrary frame and come
 * out the same every time.
 */
export function entranceCss(entrance: Entrance): string {
  switch (entrance) {
    case "mask":
      // Wipes up behind its own edge. No opacity ramp at all, which is what
      // makes it read as typeset rather than faded in.
      return `opacity: 1; clip-path: inset(calc((1 - var(--t)) * 108%) 0 0 0);`;
    case "scale":
      return `opacity: var(--t); transform: scale(calc(.86 + var(--t) * .14));`;
    case "blur":
      return `opacity: var(--t); filter: blur(calc((1 - var(--t)) * 14px));`;
    case "slide":
      return `opacity: var(--t); transform: translateX(calc((1 - var(--t)) * -.5em));`;
    case "rise":
    default:
      return `opacity: var(--t);
        transform: translateY(calc((1 - var(--t)) * .34em));
        filter: blur(calc((1 - var(--t)) * 9px));`;
  }
}
