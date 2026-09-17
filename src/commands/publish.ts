import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSpec } from "../spec/load.js";
import { declaredOutputs } from "../spec/fingerprint.js";
import { findSpecs } from "./ci.js";
import { log, ReelError } from "../util/log.js";

/**
 * `reel publish` — gather what has been rendered into a folder you can serve.
 *
 * ## The gap this closes
 *
 * Reel could produce a self-contained interactive demo and then hand you a file
 * path. Everything after that — where it lives, how somebody opens it, what the
 * link is — was left as an exercise, which is where most people stopped. The
 * interactive build is already one file with nothing external in it, so the
 * distance between "rendered" and "published" was never technical; it was that
 * nothing assembled the pieces.
 *
 * ## What it deliberately does not do
 *
 * **It does not render.** It collects what is already on disk, and says so
 * plainly when there is nothing there. A publish step that quietly re-rendered
 * would mean the thing you publish is not the thing you reviewed.
 *
 * **It does not touch git, and it does not push anywhere.** No branch is
 * created, nothing is committed, no remote is contacted. It writes a directory
 * and tells you what to do with it. Pushing to someone's `gh-pages` on their
 * behalf is not a convenience — it is a commit they did not write, to a branch
 * they may use for something else, and it cannot be undone by re-running the
 * command that did it.
 */

export interface PublishOptions {
  /** Where the site is written. */
  out: string;
  /** Spec globs, as `reel ci` takes them. */
  specs: string[];
  /** Sub-path the site is served from, e.g. `/reel` on project Pages. */
  base?: string;
  /** Heading for the index page. */
  title?: string;
}

export interface PublishedFile {
  /** Site-relative path, always with forward slashes. */
  path: string;
  /** What the link is called: `gif`, `mp4`, `interactive`, `storyboard`. */
  label: string;
}

export interface PublishedDemo {
  name: string;
  /** Which spec this came from, relative to where the command ran. */
  spec: string;
  /** Directory slug under the site root. */
  slug: string;
  /** What is linked from the card, best-first. */
  files: PublishedFile[];
  /** What to show on the index card, if anything can be shown. */
  poster?: string;
}

export interface PublishResult {
  dir: string;
  index: string;
  demos: PublishedDemo[];
  /** Specs that had nothing rendered yet. */
  unrendered: string[];
  /**
   * `dir` relative to where the command ran, or undefined when it landed
   * outside that tree — which decides whether committing it is even an option.
   */
  rel?: string;
}

/** Files a browser can open directly. A storyboard directory is copied whole. */
const EMBEDDABLE = new Set([".html", ".htm", ".webp", ".gif", ".mp4", ".webm", ".png", ".apng"]);

/**
 * Best thing to put on a card, in order.
 *
 * The interactive build first because it is the one deliverable that is more
 * than a picture; then the light animation, then the video. A GIF ranks below
 * WebP for the same reason it does everywhere else — several times the bytes
 * for a worse picture.
 */
const POSTER_ORDER = [".html", ".htm", ".webp", ".gif", ".mp4", ".webm", ".png"];

export async function publish(cwd: string, opts: PublishOptions): Promise<PublishResult> {
  const dir = resolve(cwd, opts.out);
  const specPaths = await findSpecs(cwd, opts.specs);
  if (specPaths.length === 0) {
    throw new ReelError(
      `No specs matched ${opts.specs.join(", ")}.`,
      "Point `--specs` at your demos, or run this from the directory that holds them.",
    );
  }

  const demos: PublishedDemo[] = [];
  const unrendered: string[] = [];

  for (const specPath of specPaths) {
    const loaded = await loadSpec(specPath);
    const slug = slugFor(loaded.spec.name, specPath, demos);
    const present: PublishedFile[] = [];

    for (const out of declaredOutputs(loaded)) {
      let info;
      try {
        info = await stat(out);
      } catch {
        continue; // declared but never rendered
      }
      const to = join(dir, slug, basename(out));
      if (info.isDirectory()) {
        // A storyboard: copy the stills, keeping their order in the name.
        await mkdir(to, { recursive: true });
        const frames = (await readdir(out)).sort();
        for (const f of frames) await copyFile(join(out, f), join(to, f));
        // One link, not one per frame. A card that ends in seven identical
        // `png` chips tells you nothing about any of them; a contact sheet is
        // what a storyboard was for in the first place.
        await writeFile(join(to, "index.html"), storyboardHtml(loaded.spec.name, frames), "utf8");
        present.push({
          path: webPath(join(slug, basename(out), "index.html")),
          label: `storyboard (${frames.length})`,
        });
        continue;
      }
      await mkdir(join(dir, slug), { recursive: true });
      await copyFile(out, to);
      present.push({ path: webPath(join(slug, basename(out))), label: extLabel(out) });
    }

    if (present.length === 0) {
      unrendered.push(relative(cwd, specPath));
      continue;
    }
    const poster = pickPoster(present);
    demos.push({
      name: loaded.spec.name,
      spec: webPath(relative(cwd, specPath)),
      slug,
      files: present,
      ...(poster ? { poster } : {}),
    });
  }

  if (demos.length === 0) {
    throw new ReelError(
      "Nothing to publish — none of those specs have been rendered yet.",
      `Run \`reel record\` first. Specs found but unrendered: ${unrendered.join(", ")}`,
    );
  }

  await mkdir(dir, { recursive: true });
  const index = join(dir, "index.html");
  await writeFile(index, indexHtml(demos, opts), "utf8");
  // GitHub Pages runs Jekyll over what it is given, and Jekyll skips files and
  // directories beginning with an underscore. Nothing here starts with one
  // today, but a storyboard frame or a future asset easily could, and the
  // failure is a 404 on one file with nothing to explain it.
  await writeFile(join(dir, ".nojekyll"), "", "utf8");

  const rel = relative(cwd, dir);
  const inside = !rel.startsWith("..") && !isAbsolute(rel);
  return { dir, index, demos, unrendered, ...(inside ? { rel } : {}) };
}

/** A directory name that is stable, readable, and unique within one site. */
function slugFor(name: string, specPath: string, taken: PublishedDemo[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || basename(specPath).replace(/\.reel\.ya?ml$/i, "");
  if (!taken.some((d) => d.slug === base)) return base;
  // Two demos can share a `name:`; the directory they publish into cannot.
  for (let n = 2; ; n++) {
    const tried = `${base}-${n}`;
    if (!taken.some((d) => d.slug === tried)) return tried;
  }
}

function pickPoster(files: PublishedFile[]): string | undefined {
  // The storyboard's contact sheet is an `.html` file and would otherwise
  // outrank every real deliverable — a card showing a grid of thumbnails
  // instead of the demo running.
  const candidates = files.filter((f) => !f.label.startsWith("storyboard"));
  for (const ext of POSTER_ORDER) {
    const hit = candidates.find((f) => extname(f.path).toLowerCase() === ext);
    if (hit) return hit.path;
  }
  return undefined;
}

/** Forward slashes, whatever the platform used — this goes into a URL. */
function webPath(p: string): string {
  return p.split(sep).join("/");
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** How a file is shown on its card. */
function preview(file: string, name: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return `<iframe src="${esc(file)}?embed=1" title="${esc(name)}" loading="lazy"></iframe>`;
  }
  if (ext === ".mp4" || ext === ".webm") {
    // Muted, or no browser will autoplay it and every card is a play button.
    return `<video src="${esc(file)}" autoplay loop muted playsinline aria-label="${esc(name)}"></video>`;
  }
  return `<img src="${esc(file)}" alt="${esc(name)}" loading="lazy" />`;
}

function extLabel(file: string): string {
  const ext = extname(file).toLowerCase().slice(1);
  if (ext === "html" || ext === "htm") return "interactive";
  return ext || "file";
}

/**
 * The beat a frame came from, read back out of its filename.
 *
 * The renderer names stills `02-one-spec-every-format-.png` — an index, then
 * the beat's label slugged, trailing punctuation and all. The number is already
 * the caption's position, so what is left is the only human part of the name.
 */
function beatLabel(file: string): string {
  const stem = basename(file, extname(file))
    .replace(/^\d+[-_]?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return stem || basename(file);
}

/**
 * A storyboard's own page: every beat, in order, on one scrollable sheet.
 *
 * The frames were always published; there was just no way in. A directory on a
 * static host has no index, so the only route to them was guessing filenames —
 * which meant the most useful thing for reviewing a demo beat by beat was the
 * one deliverable nobody could open.
 */
function storyboardHtml(name: string, frames: string[]): string {
  const shots = frames
    .map(
      (f, i) =>
        `    <figure><a href="${esc(f)}"><img src="${esc(f)}" alt="${esc(name)} — beat ${i + 1}" loading="lazy" /></a><figcaption>${i + 1}. ${esc(beatLabel(f))}</figcaption></figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(name)} — storyboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #12141a; --muted: #5a6376; --line: #d9dee7;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0d12; --fg: #e8ecf4; --muted: #98a1b8; --line: #333a4f; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 24px; background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0 0 28px; }
  .sheet { display: grid; gap: 22px; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
  figure { margin: 0; }
  img { width: 100%; height: auto; display: block; border: 1px solid var(--line); border-radius: 10px; background: #000; }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: inherit; }
  .back { display: inline-block; margin-top: 32px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(name)}</h1>
    <p class="sub">${frames.length} beat${frames.length === 1 ? "" : "s"}, in order.</p>
    <div class="sheet">
${shots}
    </div>
    <a class="back" href="../../">← all demos</a>
  </div>
</body>
</html>
`;
}

/**
 * The index: one card per demo, and the links under it.
 *
 * Deliberately a single file with no build step, no framework and no fetch —
 * the same rule the renderer follows. It is served from a static host, often a
 * subdirectory, sometimes offline from a filesystem, and every dependency is
 * one more way that fails for somebody.
 */
function indexHtml(demos: PublishedDemo[], opts: PublishOptions): string {
  const title = opts.title ?? "Demos";
  const cards = demos
    .map((d) => {
      const links = d.files
        .map((f) => `<a href="${esc(f.path)}">${esc(f.label)}</a>`)
        .join("");
      // Two specs are allowed to carry the same `name:`, and when they do, two
      // cards with the same heading and no way to tell them apart is worse than
      // a little extra text. Only then is the spec path worth the room.
      const ambiguous = demos.some((o) => o !== d && o.name === d.name);
      const from = ambiguous ? `\n        <p class="from">${esc(d.spec)}</p>` : "";
      return `      <article class="card">
        <div class="media">${d.poster ? preview(d.poster, d.name) : '<div class="none">no preview</div>'}</div>
        <h2>${esc(d.name)}</h2>${from}
        <nav class="links">${links}</nav>
      </article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
${opts.base ? `<base href="${esc(opts.base.replace(/\/*$/, "/"))}" />\n` : ""}<style>
  /* Both themes, because a static page has no way to ask and guessing wrong
     makes the demo it is showing harder to see, not just the page. */
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #12141a; --muted: #5a6376;
    --card: #f6f7f9; --line: #d9dee7; --accent: #3355ff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d12; --fg: #e8ecf4; --muted: #98a1b8;
      --card: #151823; --line: #333a4f; --accent: #8aa2ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0 0 36px; }
  .grid {
    display: grid; gap: 28px;
    grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr));
  }
  .card {
    background: var(--card); border: 1px solid var(--line);
    border-radius: 14px; overflow: hidden;
  }
  .media { aspect-ratio: 16 / 10; background: #000; display: block; }
  .media > * { width: 100%; height: 100%; border: 0; display: block; object-fit: contain; }
  .none { display: grid; place-items: center; color: var(--muted); background: var(--card); }
  h2 { font-size: 17px; margin: 14px 16px 8px; }
  .from { font-size: 12px; color: var(--muted); margin: -4px 16px 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .links { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 16px 16px; }
  .links a {
    font-size: 13px; text-decoration: none; color: var(--accent);
    border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px;
  }
  .links a:hover, .links a:focus-visible { border-color: var(--accent); }
  footer { color: var(--muted); font-size: 13px; margin-top: 44px; }
  @media (prefers-reduced-motion: reduce) {
    video { animation: none !important; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(title)}</h1>
    <p class="sub">${demos.length} demo${demos.length === 1 ? "" : "s"}, rendered from specs.</p>
    <div class="grid">
${cards}
    </div>
    <footer>Built with <a href="https://github.com/KirtiJha/reel">Reel</a>.</footer>
  </div>
</body>
</html>
`;
}

/** What to do with the directory that was just written. */
export function printPublish(res: PublishResult, opts: PublishOptions): void {
  log.phase("Published");
  for (const d of res.demos) {
    // Same reason the card carries the spec path: with a duplicated `name:`,
    // the only thing separating two lines would be a `-2` nobody can explain.
    const ambiguous = res.demos.some((o) => o !== d && o.name === d.name);
    const from = ambiguous ? `  [${d.spec}]` : "";
    log.info(`${d.name} → ${d.slug}/ (${d.files.length} file(s))${from}`);
  }
  for (const s of res.unrendered) log.warn(`  ${s} — declared outputs, none rendered yet`);
  log.info(`Site  ${res.dir}`);
  log.phase("Serve it");
  log.info(`  npx serve ${opts.out}`);
  log.phase("Put it on GitHub Pages");
  for (const line of pagesAdvice(res)) log.info(`  ${line}`);
  if (!opts.base) {
    log.info("  On a project site served from a sub-path, re-run with --base /<repo>/");
  }
}

/**
 * The Pages instruction, which is only true in one shape.
 *
 * "Deploy from a branch" offers exactly two folders — the repository root and
 * `/docs`. Any other directory needs a workflow, so telling somebody to set
 * `Pages → main → /site` sends them to a dropdown that does not contain `site`.
 * The folder route is worth preferring where it applies: it needs no branch, no
 * workflow and no force-push, and the demos land in the same commit as the
 * change they demonstrate — which is the whole point of demos-as-code.
 */
export function pagesAdvice(res: PublishResult): string[] {
  if (res.rel === undefined) {
    return [
      "This site is outside the repository, so there is nothing to commit.",
      "For the no-workflow route, re-run as `reel publish docs`.",
    ];
  }
  if (res.rel === "" || res.rel === "docs") {
    const folder = res.rel === "" ? "/ (root)" : "/docs";
    return [`Commit ${res.rel || "."} and set Pages → Deploy from a branch → main → ${folder}`];
  }
  return [
    `Pages can serve a folder only from / or /docs, not /${res.rel}.`,
    "Re-run as `reel publish docs` for the no-workflow route,",
    `or upload ${res.rel} with actions/upload-pages-artifact in a workflow.`,
  ];
}
