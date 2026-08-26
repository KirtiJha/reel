import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { DETERMINISTIC_LAUNCH_ARGS } from "../driver/determinism.js";
import { log, ReelError } from "../util/log.js";
import type { LoadedImage } from "./image.js";
import { isBranch, type Step } from "../spec/schema.js";

/**
 * Diagrams written as text.
 *
 * The reason to write a flowchart in the spec instead of committing a PNG is
 * that it *diffs*. A diagram that changes in a pull request shows up as changed
 * words next to the steps that changed with it, and the picture becomes a build
 * product like any other.
 *
 * Rendering one needs a browser and the `mermaid` package. Neither is needed to
 * *use* one: the PNG is cached by content hash in `.reel-cache/diagram` and
 * committed, exactly like the voice cache, so a checkout and CI draw the
 * diagram with no browser, no install and no network. That is also what keeps
 * it deterministic — a diagram is rendered once, by whoever wrote it, and every
 * later render reads the same bytes rather than re-deriving them from whatever
 * mermaid and whatever fonts that machine happens to have.
 */

export const DIAGRAM_CACHE_DIR = join(".reel-cache", "diagram");

/**
 * Bumped when a change here would render the same source differently.
 *
 * Without it a restyled diagram would keep serving the old picture from cache
 * forever, because the source it hashes did not change.
 */
const DIAGRAM_EPOCH = 1;

export function diagramCacheDir(specDir: string): string {
  return join(specDir, DIAGRAM_CACHE_DIR);
}

/**
 * The cache key: the source, the theme, and this file's render epoch.
 *
 * Deliberately *not* the mermaid version. The committed picture is the
 * authority — the point of committing it is that every machine draws the same
 * diagram — so a mermaid upgrade must not silently re-render one demo's
 * flowchart and leave the next machine disagreeing. It also keeps the key
 * computable without mermaid installed, which is the normal case.
 *
 * To redraw after upgrading mermaid, delete the cached PNG; the next render
 * writes a fresh one, and the change is reviewable in the diff like any other.
 */
export function diagramKey(source: string, theme: string): string {
  return createHash("sha256")
    .update([String(DIAGRAM_EPOCH), theme, source.trim()].join("\0"))
    .digest("hex");
}

export function diagramPath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.png`);
}

/** The installed mermaid, or null when it isn't there. */
function findMermaid(): { path: string; version: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const path = require.resolve("mermaid/dist/mermaid.min.js");
    const pkg = require("mermaid/package.json") as { version: string };
    return { path, version: pkg.version };
  } catch {
    return null;
  }
}

/**
 * A diagram as a data URI, rendering and caching it if this is the first time.
 *
 * On a warm cache — the normal case, since the cache is committed — this reads
 * one file and nothing else happens.
 */
export async function loadDiagram(
  specDir: string,
  source: string,
  theme: string,
): Promise<LoadedImage> {
  const cacheDir = diagramCacheDir(specDir);
  const key = diagramKey(source, theme);
  const cached = await readCached(diagramPath(cacheDir, key));
  if (cached) return cached;

  const found = findMermaid();
  if (!found) {
    throw new ReelError(
      "This spec draws a Mermaid diagram, and there is no rendered copy of it.",
      "Install mermaid to draw it once — `npm install --save-dev mermaid` — then commit " +
        `${DIAGRAM_CACHE_DIR} alongside the spec. After that, rendering needs neither ` +
        "mermaid nor a browser, on any machine.",
    );
  }

  log.step(`Drawing a diagram with mermaid ${found.version} — cached after this`);
  const png = await renderMermaid(source, theme, found.path);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(diagramPath(cacheDir, key), png);
  log.debug(`diagram cached: ${key.slice(0, 12)}…`);
  return toImage(png);
}

/**
 * Which diagrams in a spec have no rendered copy — what `reel check` reports.
 *
 * Mirrors the voice cache audit: the useful question before a render on another
 * machine is "will this need a tool I do not have", and the answer should not
 * be a failure five minutes into a recording.
 */
export async function missingDiagrams(
  sources: { source: string; theme: string }[],
  specDir: string,
): Promise<string[]> {
  const cacheDir = diagramCacheDir(specDir);
  const missing: string[] = [];
  for (const { source, theme } of sources) {
    const hit = await readCached(diagramPath(cacheDir, diagramKey(source, theme)));
    if (!hit) missing.push(firstLine(source));
  }
  return missing;
}

/** Every diagram a spec draws, branches included, with the theme it will use. */
export function diagramSources(
  steps: Step[],
  specTheme: string,
): { source: string; theme: string }[] {
  const out: { source: string; theme: string }[] = [];
  for (const step of steps) {
    if (isBranch(step)) {
      for (const path of step.branch.paths) out.push(...diagramSources(path.steps as Step[], specTheme));
      continue;
    }
    if (!("diagram" in step)) continue;
    out.push(
      typeof step.diagram === "string"
        ? { source: step.diagram, theme: specTheme }
        : { source: step.diagram.mermaid, theme: step.diagram.theme ?? specTheme },
    );
  }
  return out;
}

async function readCached(path: string): Promise<LoadedImage | null> {
  try {
    return toImage(await readFile(path));
  } catch {
    return null;
  }
}

function toImage(png: Buffer): LoadedImage {
  return {
    dataUri: `data:image/png;base64,${png.toString("base64")}`,
    bytes: png.length,
    mime: "image/png",
  };
}

function firstLine(source: string): string {
  return source.trim().split("\n")[0]!.slice(0, 60);
}

/**
 * Draw the diagram in Chromium and screenshot it.
 *
 * Screenshotting the browser's own render rather than converting mermaid's SVG
 * with sharp, because mermaid lays labels out in `<foreignObject>` and librsvg
 * does not implement it — the SVG path silently produces diagrams with no text
 * in them.
 */
async function renderMermaid(source: string, theme: string, mermaidPath: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, args: DETERMINISTIC_LAUNCH_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<body style="margin:0;background:transparent"><div id="d"></div></body>`,
    );
    await page.addScriptTag({ path: mermaidPath });

    const svg = await page.evaluate(
      async ({ src, dark }) => {
        const m = (window as any).mermaid;
        m.initialize({
          startOnLoad: false,
          theme: dark ? "dark" : "default",
          // Same input must produce the same markup: mermaid otherwise mixes a
          // counter (and, in places, randomness) into element ids.
          deterministicIds: true,
          deterministicIDSeed: "reel",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        });
        const { svg } = await m.render("reel-diagram", src);
        return svg as string;
      },
      { src: source, dark: theme === "dark" },
    );

    // Rendered into a padded wrapper so the screenshot has breathing room and a
    // backdrop the diagram's own colours sit on.
    await page.evaluate(
      ({ markup, dark }) => {
        const host = document.getElementById("d")!;
        host.innerHTML = markup;
        Object.assign(host.style, {
          display: "inline-block",
          padding: "28px",
          borderRadius: "14px",
          background: dark ? "#11131c" : "#ffffff",
        });
        const el = host.querySelector("svg") as SVGSVGElement | null;
        if (el) {
          // Mermaid emits `width="100%"` and a `max-width` style with a viewBox
          // and no height at all. Left alone it fills whatever it is put in;
          // stripped, it collapses to nothing, because an SVG with only a
          // viewBox has no intrinsic size. Either way the screenshot is wrong,
          // so the viewBox is what the real dimensions come from.
          const vb = (el.getAttribute("viewBox") ?? "").split(/[ ,]+/).map(Number);
          const w = vb.length === 4 && vb[2]! > 0 ? vb[2]! : 800;
          const h = vb.length === 4 && vb[3]! > 0 ? vb[3]! : 600;
          // Small diagrams are drawn at a few hundred px, which reads as a
          // thumbnail on a 1280-wide frame. Scale up to something legible,
          // capped so a wide flowchart is not upscaled into blur.
          const scale = Math.min(3, Math.max(1, 900 / w));
          el.setAttribute("width", String(Math.round(w * scale)));
          el.setAttribute("height", String(Math.round(h * scale)));
          el.style.maxWidth = "none";
          el.style.display = "block";
        }
      },
      { markup: svg, dark: theme === "dark" },
    );

    const host = page.locator("#d");
    const shot = await host.screenshot({ omitBackground: false });
    return shot;
  } catch (err) {
    throw new ReelError(
      `Mermaid could not draw this diagram: ${(err as Error).message}`,
      "Check the diagram source — mermaid.live is the quickest way to see where it trips.",
    );
  } finally {
    await browser.close().catch(() => {});
  }
}
