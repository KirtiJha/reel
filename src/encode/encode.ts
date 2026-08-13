import { writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { CapturedFrame } from "../capture/frames.js";
import { ffmpeg } from "./ffmpeg.js";
import { log, ReelError } from "../util/log.js";

export interface EncodeTargets {
  gif?: string;
  mp4?: string;
  webm?: string;
  storyboard?: string;
}

export interface EncodeOptions {
  fps: number;
  maxWidth?: number;
  /** Minimum hold on the final frame (ms). */
  tailMs: number;
  /**
   * True end of the recording (ms from capture start), per the driver. The
   * screencast only emits frames on visual change, so trailing static beats/
   * captions produce no frames; we hold the last frame until endMs so the
   * timeline reflects what actually happened.
   */
  endMs?: number;
  /** Resolved GIF params (from the output preset). */
  gif: { fps: number; maxWidth: number; colors: number };
}

/**
 * Turn timestamped frames into deliverables. A concat manifest with per-frame
 * durations reproduces the real timeline (including holds) from the sparse set
 * of frames the screencast actually emitted; ffmpeg's `fps` filter then
 * resamples to a constant output rate.
 */
export async function encode(
  frames: CapturedFrame[],
  framesDir: string,
  targets: EncodeTargets,
  opts: EncodeOptions,
): Promise<void> {
  if (frames.length === 0) {
    throw new ReelError("No frames were captured — nothing to encode.");
  }

  const manifest = buildConcatManifest(frames, opts.tailMs, opts.endMs);
  const manifestPath = join(framesDir, "frames.concat");
  await writeFile(manifestPath, manifest, "utf8");

  const scale = scaleFilter(opts.maxWidth);

  if (targets.mp4) {
    await ensureDir(targets.mp4);
    await ffmpeg(
      [
        "-y",
        "-f", "concat", "-safe", "0", "-i", "frames.concat",
        "-vf", `fps=${opts.fps},${scale},format=yuv420p`,
        ...H264, ...BITEXACT,
        abspath(framesDir, targets.mp4),
      ],
      framesDir,
    );
    log.ok(`mp4  → ${targets.mp4}`);
  }

  if (targets.webm) {
    await ensureDir(targets.webm);
    await ffmpeg(
      [
        "-y",
        "-f", "concat", "-safe", "0", "-i", "frames.concat",
        "-vf", `fps=${opts.fps},${scale}`,
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", ...BITEXACT,
        abspath(framesDir, targets.webm),
      ],
      framesDir,
    );
    log.ok(`webm → ${targets.webm}`);
  }

  if (targets.gif) {
    await ensureDir(targets.gif);
    // Two-pass palette for a clean GIF, tuned by the resolved output preset.
    const gifScale = scaleFilter(opts.gif.maxWidth);
    const palette = join(framesDir, "palette.png");
    await ffmpeg(
      [
        "-y",
        "-f", "concat", "-safe", "0", "-i", "frames.concat",
        "-vf", `fps=${opts.gif.fps},${gifScale}:flags=lanczos,palettegen=stats_mode=diff:max_colors=${opts.gif.colors}`,
        palette,
      ],
      framesDir,
    );
    await ffmpeg(
      [
        "-y",
        "-f", "concat", "-safe", "0", "-i", "frames.concat",
        "-i", "palette.png",
        "-lavfi",
        `fps=${opts.gif.fps},${gifScale}:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        abspath(framesDir, targets.gif),
      ],
      framesDir,
    );
    log.ok(`gif  → ${targets.gif}`);
  }
}

/** Write one PNG per beat into the storyboard directory. */
export async function writeStoryboard(
  beats: { label: string; t: number }[],
  frames: CapturedFrame[],
  framesDir: string,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  let i = 0;
  for (const beat of beats) {
    const frame = nearestFrame(frames, beat.t);
    if (!frame) continue;
    const safe = beat.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || `beat-${i}`;
    const ext = frame.file.slice(frame.file.lastIndexOf("."));
    await copyFile(join(framesDir, frame.file), join(outDir, `${String(i++).padStart(2, "0")}-${safe}${ext}`));
  }
  log.ok(`storyboard → ${outDir} (${i} frames)`);
}

export function buildConcatManifest(frames: CapturedFrame[], tailMs: number, endMs?: number): string {
  const lines = ["ffconcat version 1.0"];
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  // Hold the final frame until the true end of the recording (driver clock),
  // never less than the minimum tail.
  const lastDur = endMs ? Math.max(tailMs, endMs - last.t) : tailMs;
  // Anchor the timeline at t=0. The first screenshot never lands at exactly 0
  // (and under load can be seconds late), so without this lead-in the whole
  // sequence shifts earlier by `first.t`: the render pass maps frame index to
  // recording time as `i / fps`, so captions, zoom keys and storyboard beats
  // would all desync — and anything past the shortened end would be dropped.
  if (first.t > 0) {
    lines.push(`file '${first.file}'`);
    lines.push(`duration ${(first.t / 1000).toFixed(4)}`);
  }
  for (let i = 0; i < frames.length; i++) {
    const cur = frames[i]!;
    const next = frames[i + 1];
    const durMs = next ? Math.max(1, next.t - cur.t) : Math.max(1, lastDur);
    lines.push(`file '${cur.file}'`);
    lines.push(`duration ${(durMs / 1000).toFixed(4)}`);
  }
  // The concat demuxer needs the final frame repeated for its duration to stick.
  lines.push(`file '${frames[frames.length - 1]!.file}'`);
  return lines.join("\n") + "\n";
}

function nearestFrame(frames: CapturedFrame[], t: number): CapturedFrame | undefined {
  let best: CapturedFrame | undefined;
  let bestD = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.t - t);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * Strip everything ffmpeg would otherwise stamp into the container that isn't
 * the video: creation time, encoder version, and (for Matroska/WebM) a random
 * segment UID. Without this the same frames encode to different bytes on every
 * run, so committed demo media churns in CI even when the demo is unchanged.
 */
export const BITEXACT = ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1"];

/**
 * H.264 settings for video a browser will actually play.
 *
 * The level cap is the part that matters and the part that is easy to lose:
 * `veryslow` uses up to 16 reference frames, and the decoded-picture buffer
 * that implies pushes the signalled level to 5.0. Browsers decline to allocate
 * for that — Chrome parks at readyState 0 and raises no error, so the demo
 * video silently never plays in the README it was rendered for. Level 4.0
 * covers 1080p30 with room to spare; x264 reduces the reference frames to fit
 * and the quality difference is invisible at this size.
 *
 * Both encode paths (plain concat and the polish renderer) share this so the
 * two can't drift apart again.
 */
export const H264 = [
  "-c:v", "libx264",
  "-preset", "veryslow",
  "-crf", "18",
  "-profile:v", "high",
  "-level:v", "4.0",
  "-movflags", "+faststart",
];

/** Even-dimension-safe scale filter, optionally capping width. */
function scaleFilter(maxWidth?: number): string {
  if (maxWidth) return `scale='min(${maxWidth}\\,iw)':-2`;
  return `scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

function abspath(cwd: string, p: string): string {
  return p.startsWith("/") ? p : join(process.cwd(), p);
}

async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(file.startsWith("/") ? file : join(process.cwd(), file)), {
    recursive: true,
  });
}
