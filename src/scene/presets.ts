import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ReelError } from "../util/log.js";
import type { Backdrop, Look } from "./looks.js";

/**
 * Frame presets — HyperFrames' design languages, read rather than copied.
 *
 * ## Why read them
 *
 * `hyperframes-creative` ships thirteen complete design systems as `FRAME.md`
 * files: real palettes, real type ramps with named steps, spacing, component
 * recipes, and prose about when each is right. They are considerably better
 * than the ten looks in `looks.ts`, which were assembled from taste in an
 * afternoon.
 *
 * Reel resolves them from the installed skill instead of vendoring copies, for
 * the same reason the engine is a dependency rather than a fork: a copy is
 * stale the moment they ship, and their design work is theirs. Install them
 * with `npx hyperframes skills` (or `npx skills add heygen-com/hyperframes`)
 * and Reel finds them.
 *
 * ## The part that needs judgement
 *
 * A preset's colour tokens are named for its own world — `paper` / `ink`,
 * `cream` / `coral` / `black`, `ink-black` / `fire-orange` — so there is no key
 * to look up. The roles are derived from the colours themselves instead:
 * the ground is the extreme, low-chroma surface; the ink is the low-chroma
 * colour furthest from it; the accent is the most saturated thing in the
 * palette. That gets `coral`, `broadside` and `code-editorial` right on their
 * own terms, and for a genuinely two-colour system like `cobalt-grid` — where
 * the ink *is* the cobalt — it correctly collapses ink and accent onto the same
 * value rather than inventing a third.
 */

/** One step of a preset's type ramp. */
export interface TypeToken {
  fontFamily: string;
  /** Size as a percentage of the frame's width — 10.4cqw is ~200px at 1920. */
  cqw?: number;
  px?: number;
  weight?: number;
  lineHeight?: number;
  tracking?: string;
  upper?: boolean;
  italic?: boolean;
}

export interface Preset {
  /** Directory name — `cobalt-grid`. This is what a spec names. */
  name: string;
  /** The preset's own title from its frontmatter. */
  title: string;
  description: string;
  colors: Record<string, string>;
  typography: Record<string, TypeToken>;
  /** Derived roles. */
  ground: string;
  ink: string;
  muted: string;
  accent: string;
  dark: boolean;
  display: TypeToken;
  label: TypeToken;
}

/**
 * Where an installed `hyperframes-creative` skill might be.
 *
 * Checked in order, nearest first: a project-local install beats the user's
 * global one, the same way a project's own config does.
 */
function searchPaths(cwd: string): string[] {
  const tail = join("hyperframes-creative", "frame-presets");
  return [
    join(cwd, ".claude", "skills", tail),
    join(cwd, ".agents", "skills", tail),
    join(homedir(), ".claude", "skills", tail),
    join(cwd, "node_modules", "hyperframes", "dist", "skills", tail),
  ];
}

/** The directory holding the presets, or undefined when the skill is not installed. */
export async function presetRoot(cwd = process.cwd()): Promise<string | undefined> {
  for (const path of searchPaths(cwd)) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some((e) => e.isDirectory())) return path;
    } catch {
      // Not here; try the next.
    }
  }
  return undefined;
}

/** Every preset that is installed, parsed. */
export async function loadPresets(cwd = process.cwd()): Promise<Preset[]> {
  const root = await presetRoot(cwd);
  if (!root) return [];
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const out: Preset[] = [];
  for (const name of dirs) {
    const parsed = await readPreset(join(root, name), name).catch(() => undefined);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** One preset by name, with a message that says how to get them when absent. */
export async function loadPreset(name: string, cwd = process.cwd()): Promise<Preset> {
  const root = await presetRoot(cwd);
  if (!root) {
    throw new ReelError(
      `\`${name}\` is a HyperFrames frame preset, and none are installed.`,
      "Install them with `npx hyperframes skills`, or use one of Reel's own looks (`reel looks --list`).",
    );
  }
  const parsed = await readPreset(join(root, name), name).catch(() => undefined);
  if (!parsed) {
    const all = (await loadPresets(cwd)).map((p) => p.name);
    throw new ReelError(
      `No frame preset called \`${name}\`.`,
      `Installed presets: ${all.join(", ") || "none"}.`,
    );
  }
  return parsed;
}

/** Parse one `FRAME.md`: YAML frontmatter, then prose we do not need. */
async function readPreset(dir: string, name: string): Promise<Preset> {
  const raw = await readFile(join(resolve(dir), "FRAME.md"), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) throw new Error("no frontmatter");
  const doc = parseYaml(normaliseFrontmatter(m[1]!)) as {
    name?: string;
    description?: string;
    colors?: Record<string, string>;
    typography?: Record<string, TypeToken>;
  };

  const colors = doc.colors ?? {};
  const typography = doc.typography ?? {};
  const roles = deriveRoles(colors);
  const display = pickDisplay(typography);
  const label = pickLabel(typography, display);

  return {
    name,
    title: (doc.name ?? name).split("—")[0]!.trim(),
    description: summarise(doc.description ?? "", name),
    colors,
    typography,
    ...roles,
    display,
    label,
  };
}

/**
 * A one-line description worth showing.
 *
 * Every preset's `description` opens with the same boilerplate — "Video-first
 * companion to X's design.md. The unit is the frame (1920×1080)." — which says
 * nothing about what the preset looks like. The sentence after it usually does,
 * so the boilerplate is dropped and the first real clause kept.
 */
function summarise(description: string, name: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const useful = flat
    .replace(/^Video[- ]first companion to [^.]*\.\s*/i, "")
    .replace(/^The unit is the frame \([^)]*\)[^.]*\.\s*/i, "")
    .replace(/^Atoms are identical[^.]*\.\s*/i, "");
  const sentence = (useful || flat).split(". ")[0] ?? "";
  return sentence ? `${sentence.replace(/\.$/, "")}.` : `The ${name} frame preset.`;
}

/**
 * Make a `FRAME.md` frontmatter block parse as YAML.
 *
 * The type ramps are written `headline:{ fontFamily: "…" }` with no space after
 * the colon, which YAML reads as a compact mapping and rejects — "nested
 * mappings are not allowed". It is a house style rather than a mistake, and
 * every preset uses it, so a parser that refused would refuse all thirteen.
 * One space, inserted only where a key is immediately followed by a flow
 * mapping, and nothing else about the document is touched.
 */
export function normaliseFrontmatter(src: string): string {
  return src.replace(/^(\s*[\w.-]+):\{/gm, "$1: {");
}

// --- colour ---------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Hex or `rgba(...)` to RGB, or undefined for anything else. */
export function toRgb(value: string): Rgb | undefined {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(v);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return undefined;
}

/** Relative luminance, 0–1. */
export function luminance(c: Rgb): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/** Saturation in the HSL sense, 0–1. How much colour, as opposed to how light. */
export function chroma(c: Rgb): number {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  return max === 0 ? 0 : (max - min) / max;
}

/**
 * Role vocabularies.
 *
 * Presets name colours for their own world, but the vocabulary they draw on is
 * small and consistent: a surface is called paper, bg, canvas, cream or
 * offwhite; ink is ink, text, dark or black; the loud one is accent, sun, red,
 * coral or fire. Names carry more signal than pixels do here — deriving roles
 * from colour alone picked yellow as `biennale-yellow`'s ink, when the preset's
 * own description says deep indigo — so the name leads and the colour breaks
 * ties.
 */
const GROUND_HINTS = ["paper", "bg", "background", "canvas", "surface", "cream", "offwhite", "off-white", "page", "base", "light", "white"];
const INK_HINTS = ["ink", "text", "foreground", "fg", "dark", "black", "charcoal"];
const ACCENT_HINTS = ["accent", "sun", "coral", "red", "orange", "fire", "highlight", "brand", "voltage", "pop"];

/** Does this token name read as one of a role's words? */
function hintScore(key: string, hints: string[]): number {
  const k = key.toLowerCase();
  for (const [i, h] of hints.entries()) {
    // An exact name is the strongest signal; a prefix (`bg-primary`) is nearly
    // as good; a mention anywhere is weak but real.
    if (k === h) return 100 - i;
    if (k.startsWith(h + "-") || k.startsWith(h)) return 70 - i;
    if (k.includes(h)) return 40 - i;
  }
  return 0;
}

/**
 * Later, dimmer variants of a role are still that role, and should lose to the
 * primary one. `paper-deep`, `cream-muted`, `ink-soft`, `bg-secondary`.
 */
function variantPenalty(key: string): number {
  return /-(deep|dark|darker|soft|muted|hint|faint|alt|secondary|2|3|elev|strong)$/i.test(key) ? 25 : 0;
}

/** Contrast between two colours, as a plain luminance distance. */
function contrast(a: Rgb, b: Rgb): number {
  return Math.abs(luminance(a) - luminance(b));
}

export function deriveRoles(colors: Record<string, string>): {
  ground: string;
  ink: string;
  muted: string;
  accent: string;
  dark: boolean;
} {
  // Translucent tokens are overlays, hairlines and tints — never a role. One
  // of them (`white-overlay`) was winning the ground outright.
  const entries = Object.entries(colors)
    .map(([k, v]) => ({ k, v, rgb: toRgb(v), opaque: !/rgba\(/i.test(v) || /,\s*1\s*\)$/.test(v) }))
    .filter((e): e is { k: string; v: string; rgb: Rgb; opaque: boolean } => e.rgb !== undefined && e.opaque);

  if (entries.length === 0) {
    return { ground: "#0b0b0f", ink: "#ffffff", muted: "rgba(255,255,255,.66)", accent: "#6d8bff", dark: true };
  }

  const ground = entries.reduce((best, e) => {
    // Name first; then how far from mid-grey the colour is, since a surface is
    // an extreme and body copy is not.
    const score = (x: typeof e): number =>
      hintScore(x.k, GROUND_HINTS) - variantPenalty(x.k) + Math.abs(luminance(x.rgb) - 0.5) * 20;
    return score(e) > score(best) ? e : best;
  });
  const dark = luminance(ground.rgb) < 0.5;

  const rest = entries.filter((e) => e.k !== ground.k);
  const ink =
    rest.length === 0
      ? ground
      : rest.reduce((best, e) => {
          const score = (x: typeof e): number =>
            hintScore(x.k, INK_HINTS) - variantPenalty(x.k) + contrast(x.rgb, ground.rgb) * 60;
          return score(e) > score(best) ? e : best;
        });

  const forAccent = rest.filter((e) => e.k !== ink.k);
  const accent =
    forAccent.length === 0
      ? ink
      : forAccent.reduce((best, e) => {
          const score = (x: typeof e): number =>
            hintScore(x.k, ACCENT_HINTS) - variantPenalty(x.k) + chroma(x.rgb) * 60;
          return score(e) > score(best) ? e : best;
        });

  const inkRgb = ink.rgb;
  return {
    ground: ground.v,
    ink: ink.v,
    // 0.58 measured 3.5:1 against a cream ground — under AA for body copy, and
    // their contrast audit says so. 0.78 clears it without losing the hierarchy.
    muted: `rgba(${inkRgb.r},${inkRgb.g},${inkRgb.b},0.78)`,
    accent: accent.v,
    dark,
  };
}

// --- typography -----------------------------------------------------------

/** The biggest step in the ramp — what a hero line is set in. */
function pickDisplay(typography: Record<string, TypeToken>): TypeToken {
  const named = ["display-hero", "display-chapter", "display-closing", "headline", "row-headline"];
  for (const key of named) {
    const t = typography[key];
    if (t?.fontFamily) return t;
  }
  const all = Object.values(typography).filter((t) => t?.fontFamily);
  if (all.length === 0) return { fontFamily: "sans-serif", cqw: 5, weight: 700 };
  return all.reduce((big, t) => ((t.cqw ?? 0) > (big.cqw ?? 0) ? t : big));
}

/** The small letter-spaced step — slates, chrome, labels. */
function pickLabel(typography: Record<string, TypeToken>, display: TypeToken): TypeToken {
  const named = ["mono-chrome", "mono-tag", "micro", "micro-strong", "label", "eyebrow"];
  for (const key of named) {
    const t = typography[key];
    if (t?.fontFamily) return t;
  }
  const upper = Object.values(typography).filter((t) => t?.fontFamily && t.upper);
  return upper[0] ?? display;
}

/**
 * A type step as a CSS `font-size`, in px against a known frame width.
 *
 * `cqw` is a percentage of the container's width, and the container here is the
 * frame — so 10.4cqw at 1920 is 200px. Worth stating because it is most of what
 * separates their frames from a first attempt: display type at 4.6–10.4cqw is
 * roughly twice what feels right when guessing, and "one very large element" is
 * the rule it comes from.
 */
export function fontSizePx(token: TypeToken, frameWidth: number): number {
  if (token.px !== undefined) return token.px;
  if (token.cqw !== undefined) return Math.round((token.cqw / 100) * frameWidth);
  return Math.round(frameWidth * 0.05);
}

/** Every font family a preset's chosen steps need, deduped. */
export function familiesOf(preset: Preset): string[] {
  return [...new Set([preset.display.fontFamily, preset.label.fontFamily].filter(Boolean))];
}

/**
 * A frame preset, as a `Look`.
 *
 * The adaptation is mostly plumbing, with one real decision in it: **presets
 * get no bloom and no plate.** Reel's own looks are screen-native and lean on
 * glow to give type somewhere to sit; every one of these is derived from print
 * — paper, hairlines, graph grids, flat registers — and a radial bloom behind
 * the headline would be the one element that says "not this system". The
 * backdrop is the ground and a single accent hairline, and the design does the
 * rest.
 */
export function presetToLook(preset: Preset): Look {
  const t = preset.display;
  const label = preset.label;
  const backdrop = (accent: string): Backdrop => ({
    markup: `<i class="rule-top"></i><i class="rule-bottom"></i>`,
    css: `
      /* Two hairlines framing the frame. The most common device across the
         presets, and the cheapest thing that reads as a designed system. */
      .rule-top, .rule-bottom { position: absolute; left: 5%; right: 5%; height: 2px;
        background: ${accent}; opacity: .5; transform: scaleX(var(--p, 1)); transform-origin: left; }
      .rule-top { top: 5%; }
      .rule-bottom { bottom: 5%; transform-origin: right; }`,
  });

  return {
    name: preset.name,
    mood: preset.description,
    dark: preset.dark,
    ground: preset.ground,
    ink: preset.ink,
    muted: preset.muted,
    // Quoted: preset families are multi-word ("Instrument Serif", "Bebas Neue")
    // and an unquoted multi-word family is not a valid font-family value.
    display: `"${t.fontFamily}", ${serifish(t.fontFamily) ? "serif" : "sans-serif"}`,
    label: `"${label.fontFamily}", ${monoish(label.fontFamily) ? "monospace" : "sans-serif"}`,
    displayWeight: t.weight ?? 400,
    tracking: t.tracking ?? "0",
    transform: t.upper ? "uppercase" : "none",
    bloom: 0,
    entrance: "mask",
    plate: 0,
    backdrop,
    ...(t.cqw === undefined ? {} : { displayCqw: t.cqw }),
    ...(t.lineHeight === undefined ? {} : { displayLineHeight: t.lineHeight }),
    ...(label.px === undefined ? {} : { labelPx: label.px }),
  };
}

/** Rough family classification, only for choosing a generic fallback. */
function serifish(family: string): boolean {
  return /serif|garamond|playfair|newsreader|bodoni|baskerville|instrument|shrikhand/i.test(family);
}

function monoish(family: string): boolean {
  return /mono|code|courier/i.test(family);
}

/** Every face a preset needs fetched, with the weights it actually names. */
export function fontRequests(preset: Preset): { family: string; weight: number }[] {
  const out = new Map<string, { family: string; weight: number }>();
  for (const t of [preset.display, preset.label]) {
    if (!t.fontFamily) continue;
    const weight = t.weight ?? 400;
    out.set(`${t.fontFamily}@${weight}`, { family: t.fontFamily, weight });
  }
  return [...out.values()];
}
