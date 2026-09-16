import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { ffmpeg } from "../encode/ffmpeg.js";
import { CHANNEL_TOLERANCE } from "./compare.js";
import { ReelError } from "../util/log.js";

/**
 * Turning rendered media back into comparable pixels.
 *
 * Reel writes GIF, MP4 and WebM, and a comparison has to work across all three
 * — including across formats, since the committed artifact and a fresh render
 * are not always the same container. Everything is therefore resampled onto one
 * grid: a fixed rate on the time axis and a fixed geometry on the space axis.
 * Only then can two renders be subtracted from each other at all.
 */

/**
 * Sampling rate for the comparison.
 *
 * Not the render's rate: the point is to find *where* something changed, not to
 * reproduce it, and 5 samples a second localises a change to 200ms while
 * keeping a 20-second demo to a hundred images.
 */
export const DEFAULT_SAMPLE_FPS = 5;

/** Width the comparison runs at. Small enough to be fast, large enough that a changed word still registers. */
export const COMPARE_WIDTH = 480;

export interface Decoded {
  /** Sample PNGs in playback order. */
  frames: string[];
  fps: number;
  /** Derived from the frame count: ffprobe isn't shipped with ffmpeg-static. */
  durationMs: number;
}

/**
 * Decode a media file into evenly spaced sample frames.
 *
 * `fps` as a *filter* rather than an input rate is what makes the samples
 * evenly spaced in real time: Reel's own output holds a single frame across a
 * long pause, and reading frames as they are stored would sample that pause
 * once and a burst of motion fifty times.
 */
export async function decode(
  file: string,
  outDir: string,
  fps = DEFAULT_SAMPLE_FPS,
): Promise<Decoded> {
  await mkdir(outDir, { recursive: true });
  try {
    await ffmpeg([
      "-y",
      "-i", file,
      "-vf", `fps=${fps},scale=${COMPARE_WIDTH}:-2:flags=bilinear`,
      // Without this ffmpeg duplicates frames to keep a constant rate on some
      // inputs, which would report a still pause as a stream of new samples.
      "-fps_mode", "passthrough",
      join(outDir, "%05d.png"),
    ]);
  } catch (err) {
    throw new ReelError(
      `Could not read ${file} as a video: ${(err as Error).message}`,
      "reel diff compares rendered media — pass the GIF, MP4 or WebM a render produced.",
    );
  }

  const frames = (await readdir(outDir))
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => join(outDir, f));

  if (frames.length === 0) {
    throw new ReelError(
      `${file} decoded to no frames.`,
      "The file may be empty or truncated; re-run the render that produced it.",
    );
  }
  return { frames, fps, durationMs: Math.round((frames.length / fps) * 1000) };
}

export interface Geometry {
  width: number;
  height: number;
}

/**
 * The grid both renders are compared on.
 *
 * Taken from the newer render, because when a viewport changes it is the new
 * shape that a reader is trying to look at. The difference in shape is reported
 * separately rather than being silently absorbed here.
 */
export async function geometryOf(framePath: string): Promise<Geometry> {
  const meta = await sharp(framePath).metadata();
  const width = meta.width ?? COMPARE_WIDTH;
  const height = meta.height ?? Math.round((COMPARE_WIDTH * 9) / 16);
  return { width, height };
}

/** Raw RGB for one sample, normalised onto the comparison grid. */
export async function pixels(framePath: string, geo: Geometry): Promise<Buffer> {
  return sharp(framePath)
    // `fill` rather than `contain`: a letterboxed comparison would report the
    // padding bars as the change whenever the aspect ratio moved.
    .resize(geo.width, geo.height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
}

/**
 * A before/after/difference strip for one moment.
 *
 * The amplified difference channel is the part that earns the image: a reviewer
 * comparing two near-identical screenshots by eye will miss a changed label,
 * and highlighting exactly which pixels moved turns that into a glance.
 */
export async function writeComparisonStrip(
  beforeFrame: string,
  afterFrame: string,
  geo: Geometry,
  outPath: string,
): Promise<void> {
  const [a, b] = await Promise.all([pixels(beforeFrame, geo), pixels(afterFrame, geo)]);
  const diff = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(
      Math.abs(a[i]! - b[i]!),
      Math.abs(a[i + 1]! - b[i + 1]!),
      Math.abs(a[i + 2]! - b[i + 2]!),
    );
    // Changed pixels burn magenta over a dimmed copy of the new render, so the
    // highlight stays legible in place instead of floating on black.
    const hot = d > CHANNEL_TOLERANCE;
    diff[i] = hot ? 255 : Math.round(b[i]! * 0.25);
    diff[i + 1] = hot ? 0 : Math.round(b[i + 1]! * 0.25);
    diff[i + 2] = hot ? 255 : Math.round(b[i + 2]! * 0.25);
  }

  const raw = { width: geo.width, height: geo.height, channels: 3 as const };
  const gap = 8;
  const panels = await Promise.all([
    sharp(a, { raw }).png().toBuffer(),
    sharp(b, { raw }).png().toBuffer(),
    sharp(diff, { raw }).png().toBuffer(),
  ]);

  await sharp({
    create: {
      width: geo.width * 3 + gap * 2,
      height: geo.height,
      channels: 3,
      background: "#101014",
    },
  })
    .composite(panels.map((input, i) => ({ input, left: i * (geo.width + gap), top: 0 })))
    .png()
    .toFile(outPath);
}
