import { readFile } from "node:fs/promises";
import { ReelError } from "../util/log.js";

/**
 * Post-encode sanity checks.
 *
 * ffmpeg can exit 0 having written far less than it was asked to — a GIF
 * filtergraph that finishes early still returns success, and the encoder
 * happily reports the file as written. A demo that silently lost most of its
 * length is worse than one that failed outright: the failure is discovered by
 * whoever watches the README six weeks later, not by the person who rendered
 * it. These checks turn that into an error at the point of encoding.
 */

/**
 * Count frames in a GIF by its Graphic Control Extension blocks.
 *
 * Reading the container directly avoids depending on ffprobe, which
 * `ffmpeg-static` does not ship.
 */
export function countGifFrames(buf: Buffer): number {
  let n = 0;
  // Each frame is introduced by an extension block: 0x21 0xF9 0x04.
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) n++;
  }
  return n;
}

/**
 * Fail when a written GIF holds far fewer frames than the render produced.
 *
 * The threshold is deliberately loose: a GIF legitimately drops frames to hit
 * its target rate, and identical frames may be coalesced. Anything under half
 * the expected count is not compression, it is truncation.
 */
export async function assertGifComplete(
  path: string,
  expectedFrames: number,
  label: string,
): Promise<void> {
  if (expectedFrames <= 0) return;
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    throw new ReelError(
      `The GIF was reported as written but is not readable: ${label}`,
      "Re-run the render; if it persists, drop `gif:` from the spec's output and use mp4.",
    );
  }
  if (buf.length === 0) {
    throw new ReelError(
      `The GIF encoded to an empty file: ${label}`,
      "Re-run the render. If it persists, lower `output.preset` fidelity or drop `gif:` and use mp4.",
    );
  }
  const actual = countGifFrames(buf);
  if (actual * 2 < expectedFrames) {
    throw new ReelError(
      `The GIF is truncated: ${label} holds ${actual} frames, expected about ${expectedFrames}.`,
      "ffmpeg exited cleanly but stopped early, so the demo would be missing most of its length. " +
        "Re-run the render; if it repeats, drop `gif:` from the spec's output and use mp4.",
    );
  }
}
