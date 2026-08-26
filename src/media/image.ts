import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { resolveFrom } from "../spec/load.js";
import { ReelError } from "../util/log.js";

/**
 * Images a spec brings in, read from disk and never from the network.
 *
 * The renderer only ever reads local files. A fetch during a render would make
 * the output depend on a server being up and on what it served that day —
 * which is the byte-identical promise gone — and it would quietly pull
 * someone else's artwork into a video that gets published. Studio may download
 * an asset while you are editing, into the spec's own directory, where it is
 * committed and reviewed like any other input.
 */

/** What a browser will actually decode in an `<img>`. */
const TYPES: { ext: string; mime: string; magic?: (b: Buffer) => boolean }[] = [
  { ext: ".png", mime: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".jpg", mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { ext: ".jpeg", mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { ext: ".gif", mime: "image/gif", magic: (b) => b.subarray(0, 3).toString("latin1") === "GIF" },
  { ext: ".webp", mime: "image/webp", magic: (b) => b.subarray(8, 12).toString("latin1") === "WEBP" },
  { ext: ".avif", mime: "image/avif" },
  { ext: ".svg", mime: "image/svg+xml" },
];

export interface LoadedImage {
  /** `data:<mime>;base64,…` — what the overlay puts in an `<img>`. */
  dataUri: string;
  bytes: number;
  mime: string;
}

/**
 * Read an image named relative to the spec.
 *
 * The extension picks the type and the magic bytes check it, because a `.png`
 * that is really a JPEG decodes fine in a browser and would otherwise produce a
 * data URI a stricter consumer rejects.
 */
export async function loadImage(specDir: string, file: string): Promise<LoadedImage> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    throw new ReelError(
      `\`image: ${file}\` is a URL, and a render never fetches.`,
      "Download it into the spec's directory and reference it by path, so the picture " +
        "is committed and reviewed like every other input.",
    );
  }
  const path = resolveFrom(specDir, file);
  const ext = extname(path).toLowerCase();
  const known = TYPES.find((t) => t.ext === ext);
  if (!known) {
    throw new ReelError(
      `\`image: ${file}\` is not an image Reel can show.`,
      `Supported: ${[...new Set(TYPES.map((t) => t.ext))].join(", ")}.`,
    );
  }

  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    throw new ReelError(
      `\`image: ${file}\` was not found.`,
      `Looked in ${path}. Image paths are relative to the spec, like every other path in it.`,
    );
  }
  if (buf.length === 0) {
    throw new ReelError(`\`image: ${file}\` is empty.`, "Re-export it, or point at a different file.");
  }
  // Only a mismatch is worth a word; a correct file says nothing.
  const mime =
    known.magic && !known.magic(buf)
      ? TYPES.find((t) => t.magic?.(buf))?.mime ?? known.mime
      : known.mime;

  return { dataUri: `data:${mime};base64,${buf.toString("base64")}`, bytes: buf.length, mime };
}
