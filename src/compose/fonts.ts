import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../util/log.js";

/**
 * Vendoring webfonts, at compose time.
 *
 * ## Why this is allowed, when fetching at render time is not
 *
 * Reel's rule is that a *render* never fetches: it must not depend on anyone
 * else's uptime, and a blocked request at render time either fails the job or —
 * worse, for a font — silently substitutes a different typeface, so the film
 * ships looking wrong rather than not at all.
 *
 * Composing is a different moment. It is authoring, it happens once, and its
 * output is committed. Downloading a font here and writing it into the project
 * is the same act as saving an image next to a spec, and it is what makes the
 * render self-contained afterwards. The frame presets are built on Google Fonts
 * — Instrument Serif, Bebas Neue, Newsreader, EB Garamond, Shrikhand — and
 * without this step every one of them would render in a system fallback, which
 * is to say none of them would render as themselves.
 *
 * ## What it fetches
 *
 * Only the `latin` subset, and only the weights a preset actually names. A
 * family's full set is a dozen files across a dozen scripts; a demo needs one.
 * When the network is unavailable the project still composes — the faces fall
 * back to `local()` declarations and the caller is told plainly, rather than
 * the film quietly changing typeface.
 */

/** A face to fetch: one family at one weight. */
export interface FontRequest {
  family: string;
  weight: number;
  italic?: boolean;
}

export interface VendoredFont {
  family: string;
  weight: number;
  /** Path relative to the directory the CSS lives in. */
  file: string;
}

/**
 * A browser-ish UA, because Google Fonts serves a different format to each.
 *
 * With the default Node user agent the API returns `truetype` rather than
 * `woff2` — several times the bytes for the same glyphs. This is a content
 * negotiation, not a disguise: we genuinely want the modern format, and
 * Chromium is what renders the result.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** `Instrument Serif` → `Instrument+Serif`. */
function familyParam(r: FontRequest): string {
  const name = r.family.trim().replace(/\s+/g, "+");
  return r.italic ? `${name}:ital,wght@1,${r.weight}` : `${name}:wght@${r.weight}`;
}

/** A filename that cannot collide or surprise a filesystem. */
function fileFor(r: FontRequest): string {
  const slug = r.family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug}-${r.weight}${r.italic ? "i" : ""}.woff2`;
}

/**
 * Pull the latin `src: url(...)` out of a Google Fonts stylesheet.
 *
 * The response is a run of `@font-face` blocks, one per unicode subset, each
 * preceded by a `/* latin *​/` style comment. Taking the block that follows the
 * `latin` comment — rather than the first or the last — is what keeps a demo
 * from shipping with Cyrillic glyph coverage and no Latin.
 */
export function latinWoff2(css: string): string | undefined {
  const blocks = css.split("/*").map((b) => "/*" + b);
  for (const block of blocks) {
    if (!/^\/\*\s*latin\s*\*\//.test(block)) continue;
    const url = /src:\s*url\((https:\/\/[^)]+\.woff2)\)/.exec(block);
    if (url) return url[1];
  }
  // Some families ship a single unsubsetted face with no comments at all.
  return /src:\s*url\((https:\/\/[^)]+\.woff2)\)/.exec(css)?.[1];
}

/**
 * Fetch each face and write it into `<dir>/fonts/`.
 *
 * Returns what actually landed. A family that could not be fetched is simply
 * absent from the result, and the caller declares it `local()` instead — a
 * degradation the caller can report, rather than one nobody notices.
 */
export async function vendorFonts(
  dir: string,
  requests: FontRequest[],
  timeoutMs = 20_000,
): Promise<VendoredFont[]> {
  if (requests.length === 0) return [];
  const out: VendoredFont[] = [];
  await mkdir(join(dir, "fonts"), { recursive: true });

  for (const req of requests) {
    try {
      const cssUrl = `https://fonts.googleapis.com/css2?family=${familyParam(req)}&display=block`;
      const css = await get(cssUrl, timeoutMs, { "user-agent": UA });
      const woff2 = latinWoff2(await css.text());
      if (!woff2) continue;
      const bin = await get(woff2, timeoutMs, {});
      const bytes = Buffer.from(await bin.arrayBuffer());
      // A handful of bytes is an error page, not a font.
      if (bytes.length < 1024) continue;
      const file = fileFor(req);
      await writeFile(join(dir, "fonts", file), bytes);
      out.push({ family: req.family, weight: req.weight, file: `fonts/${file}` });
    } catch {
      // Offline, blocked, or the family does not exist. The caller falls back.
    }
  }
  return out;
}

async function get(url: string, timeoutMs: number, headers: Record<string, string>): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

/**
 * `@font-face` rules for what was vendored, plus `local()` for what was not.
 *
 * Both are declared, because `hyperframes check` rejects a family it cannot
 * resolve — correctly, since a silently substituted face is not the typography
 * anyone approved. A `local()` declaration at least states the truth: this face
 * is expected to already be on the machine.
 */
export function faceRules(vendored: VendoredFont[], allFamilies: string[], indent = "      "): string {
  const rules: string[] = [];
  const got = new Set<string>();
  for (const v of vendored) {
    got.add(v.family);
    rules.push(
      `${indent}@font-face { font-family: "${v.family}"; font-weight: ${v.weight}; font-display: block;\n` +
        `${indent}  src: url("${v.file}") format("woff2"); }`,
    );
  }
  for (const family of allFamilies) {
    if (got.has(family)) continue;
    rules.push(`${indent}@font-face { font-family: "${family}"; src: local("${family}"); }`);
  }
  return rules.join("\n");
}

/** Say plainly what was fetched and what fell back. */
export function reportFonts(vendored: VendoredFont[], requested: string[]): void {
  const got = new Set(vendored.map((v) => v.family));
  const missing = requested.filter((f) => !got.has(f));
  if (vendored.length > 0) log.info(`Fonts       vendored ${vendored.length} face(s): ${[...got].join(", ")}`);
  if (missing.length > 0) {
    log.warn(
      `Fonts       could not fetch ${missing.join(", ")} — declared as local() instead, ` +
        `so they render only if installed on the rendering machine.`,
    );
  }
}

/**
 * `@font-face` rules with the font bytes inlined as data URIs.
 *
 * For a self-contained preview document — `reel looks` renders every identity
 * into one image, and a preset shown in a system fallback rather than its own
 * face is not the identity you would be choosing. Inlining keeps the document
 * a single string with nothing to resolve, which is what the scene preview
 * pipeline wants.
 *
 * Not used for a project: there the faces are real files, which the render
 * reads once instead of parsing megabytes of base64 per frame.
 */
export async function inlineFaceRules(
  requests: FontRequest[],
  timeoutMs = 20_000,
): Promise<string> {
  const rules: string[] = [];
  for (const req of requests) {
    try {
      const cssUrl = `https://fonts.googleapis.com/css2?family=${familyParam(req)}&display=block`;
      const css = await get(cssUrl, timeoutMs, { "user-agent": UA });
      const woff2 = latinWoff2(await css.text());
      if (!woff2) continue;
      const bin = await get(woff2, timeoutMs, {});
      const bytes = Buffer.from(await bin.arrayBuffer());
      if (bytes.length < 1024) continue;
      rules.push(
        `@font-face { font-family: "${req.family}"; font-weight: ${req.weight}; font-display: block;` +
          ` src: url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2"); }`,
      );
    } catch {
      // Offline or unavailable: the stack's generic fallback still draws.
    }
  }
  return rules.join("\n");
}
