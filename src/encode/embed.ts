import { basename, extname, relative, sep } from "node:path";

/**
 * The line you paste, printed beside the file that was written.
 *
 * ## Why this is worth a module
 *
 * A render used to end by listing four paths, and the next thing anybody does
 * with a demo is put it somewhere. That last step is entirely manual and it is
 * different for every format: a GIF is Markdown image syntax, an MP4 is not
 * (Markdown has no video), and the interactive build is an iframe with a query
 * parameter you have to know about. So the tool renders something good and then
 * hands over a file path and a small research task.
 *
 * None of this is clever. It is the difference between finishing and almost
 * finishing, which is where most tools lose people.
 */

export interface EmbedSnippet {
  /** The output this describes, as given. */
  file: string;
  /** What to call it in a sentence — "GIF", "MP4", "interactive build". */
  kind: string;
  /** The markup to paste. */
  code: string;
  /** Why this form and not another, when that is not obvious. */
  note?: string;
}

export interface EmbedOptions {
  /** Paths are printed relative to this — usually the repo root. */
  from?: string;
  /** Alt text and the video's accessible name. */
  title?: string;
}

/**
 * Markdown needs a forward slash whatever the platform used.
 *
 * A Windows render that printed `out\demo.gif` would produce a snippet that is
 * silently broken everywhere it is pasted — GitHub reads the backslash as an
 * escape, not a separator.
 */
function webPath(file: string, from?: string): string {
  const p = from ? relative(from, file) : file;
  return p.split(sep).join("/");
}

/** A readable default when the spec did not name the demo. */
function altFor(file: string, title?: string): string {
  if (title) return title;
  return basename(file, extname(file)).replace(/[-_]+/g, " ");
}

/**
 * One snippet per deliverable that has somewhere sensible to go.
 *
 * A storyboard directory and a bare audio track are left out on purpose: there
 * is no single line that embeds a folder, and inventing one would be worse than
 * saying nothing.
 */
export function embedSnippets(outputs: string[], opts: EmbedOptions = {}): EmbedSnippet[] {
  const out: EmbedSnippet[] = [];
  for (const file of outputs) {
    const ext = extname(file).toLowerCase();
    const src = webPath(file, opts.from);
    const alt = altFor(file, opts.title);

    if (ext === ".gif" || ext === ".webp" || ext === ".png" || ext === ".apng") {
      out.push({ file, kind: ext.slice(1).toUpperCase(), code: `![${alt}](${src})` });
      continue;
    }

    if (ext === ".mp4" || ext === ".webm") {
      out.push({
        file,
        kind: ext.slice(1).toUpperCase(),
        // Markdown has no video syntax, so this is raw HTML — which GitHub
        // renders in a README and most static-site generators pass through.
        // `muted` is not decoration: a video that is not muted will not
        // autoplay in any modern browser, so without it the demo is a still
        // frame with a play button.
        code:
          `<video src="${src}" autoplay loop muted playsinline ` +
          `width="720" aria-label="${alt}"></video>`,
        note: "Markdown has no video tag; GitHub renders this HTML in a README.",
      });
      continue;
    }

    if (ext === ".html" || ext === ".htm") {
      out.push({
        file,
        kind: "interactive build",
        code: `<iframe src="${src}?embed=1" width="100%" height="560" style="border:0" title="${alt}"></iframe>`,
        note: "`?embed=1` drops the page chrome so it sits inside your own.",
      });
      continue;
    }
  }
  return out;
}

/**
 * The snippets as printable lines.
 *
 * Kept separate from the printing itself so the same list can be emitted as
 * JSON by `--json` without a logger in the middle.
 */
export function formatEmbeds(snippets: EmbedSnippet[]): string[] {
  const lines: string[] = [];
  for (const s of snippets) {
    lines.push(`${s.kind}`);
    lines.push(`  ${s.code}`);
    if (s.note) lines.push(`  ${s.note}`);
  }
  return lines;
}
