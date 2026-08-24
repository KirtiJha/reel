import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, ffmpegProbe } from "./ffmpeg.js";
import { log, ReelError } from "../util/log.js";

/**
 * Turning spoken lines into one track, and putting that track on the video.
 *
 * The mix is built from the same demo-time positions everything else uses, so
 * placing a line is `adelay` at its timestamp and nothing more clever. The one
 * judgement call is loudness: platforms normalise to about -14 LUFS on upload,
 * so a track mastered anywhere else gets moved anyway — and gets moved
 * inconsistently between platforms. Doing it here is what separates "sounds
 * produced" from "sounds like a screen capture".
 */

/** What YouTube, LinkedIn and Spotify all converge on. */
const TARGET_LUFS = -14;
const TRUE_PEAK_DB = -1.5;
const LOUDNESS_RANGE = 11;

const SAMPLE_RATE = 48_000;
const BITRATE = "192k";

export interface MixLine {
  /** Where the line starts, in ms of demo time. */
  t: number;
  file: string;
}

/**
 * Read a media file's duration in ms.
 *
 * Parsed from ffmpeg's own report rather than shelling out to ffprobe, which
 * `ffmpeg-static` does not ship — adding a second binary to the dependency tree
 * for one number would be a poor trade.
 */
export async function probeDurationMs(file: string): Promise<number> {
  const out = await ffmpegProbe(["-i", file]);
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(out);
  if (!m) {
    throw new ReelError(
      `Could not read the duration of ${file}.`,
      "The file may be truncated or not audio at all — delete it from the voice cache and re-render.",
    );
  }
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.round(((h * 60 + min) * 60 + s) * 1000);
}

/**
 * Mix spoken lines into a single track of exactly `durationMs`.
 *
 * Padded and trimmed to the video's length rather than left to end with the
 * last word: a track shorter than its picture makes `-shortest` cut the video,
 * and a demo that loses its final beat to a silent tail is a confusing bug to
 * chase.
 */
export async function mixNarration(
  lines: MixLine[],
  out: string,
  durationMs: number,
): Promise<void> {
  if (lines.length === 0) throw new ReelError("Nothing to mix — no spoken lines.");
  const seconds = (durationMs / 1000).toFixed(3);

  const inputs = lines.flatMap((l) => ["-i", l.file]);
  const delayed = lines.map(
    (l, i) => `[${i}:a]aresample=${SAMPLE_RATE},adelay=${Math.max(0, Math.round(l.t))}:all=1[d${i}]`,
  );

  // `amix` needs two or more inputs; a single-line demo is just the one stream.
  const merged =
    lines.length === 1
      ? "[d0]anull[m]"
      : `${lines.map((_, i) => `[d${i}]`).join("")}amix=inputs=${lines.length}:normalize=0:duration=longest[m]`;

  const graph = [
    ...delayed,
    merged,
    // Normalise, then fix the length. loudnorm resamples internally and can
    // shift the tail by a few ms, so the trim has to come after it.
    `[m]loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE},` +
      `aresample=${SAMPLE_RATE},apad,atrim=0:${seconds},` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo[out]`,
  ].join(";");

  await ffmpeg([
    "-y",
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    BITRATE,
    out,
  ]);
}

/**
 * Put an existing track onto an existing video, in place.
 *
 * The video is stream-copied, so this costs no quality and no re-encode — the
 * picture that was verified is bit-for-bit the picture that ships.
 */
export async function muxAudio(video: string, audio: string): Promise<void> {
  const tmp = join(
    video.slice(0, video.lastIndexOf("/") + 1) || ".",
    `.reel-mux-${Date.now().toString(36)}.mp4`,
  );
  try {
    await ffmpeg([
      "-y",
      "-i",
      video,
      "-i",
      audio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-shortest",
      "-movflags",
      "+faststart",
      tmp,
    ]);
    await rename(tmp, video);
    log.ok(`audio → ${video}`);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
