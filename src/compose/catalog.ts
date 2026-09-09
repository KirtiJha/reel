import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../util/log.js";

/**
 * Catalog blocks, made renderable offline.
 *
 * ## The problem this solves
 *
 * `npx hyperframes add <block>` installs real, well-made compositions — 155
 * blocks and 220 components, shader transitions and code reveals and chart
 * races among them — and every one of them arrives linking a CDN:
 *
 * ```html
 * <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
 * @import url("https://fonts.googleapis.com/css2?family=Bebas+Neue&…");
 * ```
 *
 * That is a reasonable default for a machine with open egress and fatal
 * anywhere else. The first render attempted in this sandbox failed exactly
 * there, with `sub_timeline_script_failure` naming the jsdelivr URL — and a
 * *silent* variant is worse: a blocked font import does not fail the render, it
 * quietly substitutes a different typeface, so the block ships looking wrong
 * rather than not at all.
 *
 * Rewriting is therefore not a workaround for this environment. A render must
 * not depend on anyone's uptime, which is a rule Reel already held and the
 * catalog does not.
 *
 * ## What it does, and what it deliberately leaves alone
 *
 * Two edits, both narrow:
 *
 *  - the GSAP `<script src>` is re-pointed at the project's vendored copy,
 *  - remote font `@import`s and `<link>`s are dropped, and the families they
 *    were fetching are declared as `local()` faces so the block still names the
 *    typography it wants and `check` can still resolve it.
 *
 * Everything else in the block — its markup, its timeline, its design — is left
 * exactly as the catalog wrote it. A block that has been edited beyond
 * recognition is no longer the block you installed.
 */

/** `https://cdn…/gsap@3.14.2/dist/gsap.min.js` → the vendored copy. */
const GSAP_SRC = /(<script[^>]+src=")https?:\/\/[^"]*gsap[^"]*("[^>]*>)/gi;
/** `@import url("https://fonts.googleapis.com/css2?family=Foo+Bar&…")` */
const FONT_IMPORT = /@import\s+url\(\s*["']?(https?:\/\/fonts\.googleapis\.com[^"')]+)["']?\s*\)\s*;?/gi;
/** `<link rel="stylesheet" href="https://fonts.googleapis.com/…">` */
const FONT_LINK = /<link[^>]+href="https?:\/\/fonts\.(googleapis|gstatic)\.com[^"]*"[^>]*>/gi;

/**
 * Pull the family names out of a Google Fonts URL.
 *
 * `family=Space+Mono:wght@400;700&family=Bebas+Neue` → `Space Mono`,
 * `Bebas Neue`. Weights and the `display` parameter are dropped: a local face
 * either exists or it does not, and naming a weight it cannot supply would be a
 * claim the machine cannot honour.
 */
export function familiesInUrl(url: string): string[] {
  const out: string[] = [];
  for (const m of url.matchAll(/family=([^&:]+)/g)) {
    const name = decodeURIComponent(m[1]!).replace(/\+/g, " ").trim();
    if (name) out.push(name);
  }
  return out;
}

/**
 * Rewrite one block's HTML.
 *
 * Returns the new source and what changed, so the caller can say plainly which
 * blocks it touched rather than editing files silently.
 */
export function deCdn(html: string, gsapHref: string): { html: string; gsap: number; fonts: string[] } {
  let gsap = 0;
  let out = html.replace(GSAP_SRC, (_m, open: string, close: string) => {
    gsap++;
    return `${open}${gsapHref}${close}`;
  });

  const families: string[] = [];
  out = out.replace(FONT_IMPORT, (_m, url: string) => {
    families.push(...familiesInUrl(url));
    return "";
  });
  out = out.replace(FONT_LINK, (m) => {
    const href = /href="([^"]+)"/.exec(m)?.[1];
    if (href) families.push(...familiesInUrl(href));
    return "";
  });

  const unique = [...new Set(families)];
  if (unique.length > 0) {
    // Declared rather than merely dropped: `check` rejects a family it cannot
    // resolve, correctly — a silently substituted face is not the typography
    // the block's author chose. `local()` says the true thing, which is that
    // the face is expected to already be on the machine.
    const faces = unique.map((f) => `      @font-face { font-family: "${f}"; src: local("${f}"); }`).join("\n");
    out = out.replace(/<style([^>]*)>/i, (m, attrs: string) => `<style${attrs}>\n${faces}`);
  }
  return { html: out, gsap, fonts: unique };
}

/**
 * De-CDN every block installed under `compositions/`.
 *
 * Run after `hyperframes add`, before any render. Skips the project's own scene
 * files — those are written by Reel and never linked a CDN in the first place.
 */
export async function deCdnInstalled(dir: string, gsapHref = "../gsap.min.js"): Promise<string[]> {
  const root = join(dir, "compositions");
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".html"))
      .map((e) => e.name);
  } catch {
    return [];
  }

  const touched: string[] = [];
  for (const name of entries) {
    const path = join(root, name);
    const src = await readFile(path, "utf8");
    const res = deCdn(src, gsapHref);
    if (res.gsap === 0 && res.fonts.length === 0) continue;
    await writeFile(path, res.html);
    touched.push(name);
    log.info(
      `De-CDN ${name} — ${res.gsap} script(s), ${res.fonts.length} font famil${res.fonts.length === 1 ? "y" : "ies"} declared locally`,
    );
  }
  return touched;
}
