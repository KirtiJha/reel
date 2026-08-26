import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { ReelError, log } from "../util/log.js";

/**
 * Adding a picture to a demo, while you are editing it.
 *
 * The rule the renderer keeps is that it never fetches: a render reads local
 * files only, so the output cannot depend on a server being up or on what it
 * served today. That rule is about *rendering*. Fetching while somebody is
 * editing is a different moment with a different answer — the file lands in the
 * spec's own directory, gets committed, and is reviewed like any other input.
 *
 * So this is the one place in Reel that downloads, and it downloads to disk
 * rather than into a render.
 */

/** Big enough for a screenshot or a logo; small enough not to be a surprise. */
const MAX_BYTES = 25 * 1024 * 1024;

/** What a browser will decode, matching `loadImage`. */
const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);

export interface AddedAsset {
  /** Path relative to the spec, which is what the `image:` step wants. */
  path: string;
  bytes: number;
}

/**
 * Write bytes into the spec's directory under a safe name.
 *
 * The name is taken apart and rebuilt rather than trusted: a browser upload
 * carries whatever the file was called, and `../../.ssh/id_rsa` is a file name
 * too. Only the basename survives, and only with an extension Reel can show.
 */
export async function addAsset(
  specPath: string,
  name: string,
  bytes: Buffer,
  subdir = "assets",
): Promise<AddedAsset> {
  if (bytes.length === 0) throw new ReelError("That file is empty.");
  if (bytes.length > MAX_BYTES) {
    throw new ReelError(
      `That file is ${(bytes.length / 1024 / 1024).toFixed(1)}MB, over the ${MAX_BYTES / 1024 / 1024}MB limit.`,
      "Large media makes a repository painful to clone. Export it smaller, or reference it from a path you manage yourself.",
    );
  }
  const safe = safeName(name);
  const dir = join(dirname(specPath), subdir);
  await mkdir(dir, { recursive: true });
  const target = join(dir, safe);
  await writeFile(target, bytes);
  log.ok(`Added ${relative(dirname(specPath), target)} (${(bytes.length / 1024).toFixed(0)}KB)`);
  return { path: relative(dirname(specPath), target).split("\\").join("/"), bytes: bytes.length };
}

/**
 * Download a URL into the spec's directory.
 *
 * Only http and https, and only what a render could have shown anyway. A local
 * tool bound to loopback fetching whatever it is handed is still a request made
 * from this machine, so the scheme check is not a formality — it is what stops
 * `file:///etc/passwd` being copied into a repository by a paste.
 */
export async function addAssetFromUrl(specPath: string, url: string): Promise<AddedAsset> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ReelError(`“${url}” is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ReelError(
      `Only http and https can be downloaded, not ${parsed.protocol.replace(":", "")}.`,
      "Copy the file into the spec's directory yourself and reference it by path.",
    );
  }

  // Plain fetch, deliberately. The CONNECT tunnel the voice provider uses is a
  // Node `https.Agent`, which undici's fetch will not take, and a download that
  // fails behind a corporate proxy has an obvious manual alternative: save the
  // file and drop it in. A render never fetches, so nothing automated depends
  // on this working.
  const res = await fetch(parsed, { redirect: "follow" });
  if (!res.ok) throw new ReelError(`${parsed.host} answered ${res.status} for that URL.`);

  const buf = Buffer.from(await res.arrayBuffer());
  // The name comes from the URL path; the content type only fills a gap, since
  // a server is free to say `application/octet-stream` for a perfectly good PNG.
  const fromPath = basename(parsed.pathname) || "asset";
  const name = ALLOWED.has(extname(fromPath).toLowerCase())
    ? fromPath
    : `${fromPath}${extensionFor(res.headers.get("content-type"))}`;
  return addAsset(specPath, name, buf);
}

function extensionFor(contentType: string | null): string {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
  };
  const ext = map[t];
  if (!ext) {
    throw new ReelError(
      `That URL served ${t || "an unknown type"}, which is not an image Reel can show.`,
      `Supported: ${[...ALLOWED].join(", ")}.`,
    );
  }
  return ext;
}

/**
 * A file name that cannot escape the directory it is written to.
 *
 * Only the basename, only an allowed extension, and nothing that could be read
 * as a path. A dropped file's name comes from a browser and is not evidence of
 * anything.
 */
export function safeName(name: string): string {
  const base = basename(name.split("\\").join("/")).replace(/[^A-Za-z0-9._-]+/g, "-");
  const ext = extname(base).toLowerCase();
  if (!ALLOWED.has(ext)) {
    throw new ReelError(
      `“${basename(name)}” is not an image Reel can show.`,
      `Supported: ${[...ALLOWED].join(", ")}.`,
    );
  }
  const stem = base.slice(0, -ext.length).replace(/^[-.]+/, "") || "asset";
  return `${stem}${ext}`;
}
