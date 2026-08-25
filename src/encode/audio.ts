import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ffmpeg, ffmpegProbe } from "./ffmpeg.js";
import { BITEXACT } from "./encode.js";
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

/**
 * Bring one input to the format everything else is in.
 *
 * Applied to every source before it reaches a mixer, rather than left to
 * ffmpeg's own negotiation. The inputs genuinely differ: a vendor's speech mp3,
 * a music file the author chose, and a mono WAV of synthesized clicks arrive
 * with three different layouts and rates, and asking the graph to reconcile
 * them at the far end fails with "Cannot select channel layout" — minutes into
 * a render, after the picture is already encoded.
 */
const FORMAT_OUT = "aformat=sample_fmts=fltp:channel_layouts=stereo";
const NORMALIZE = `aresample=${SAMPLE_RATE},${FORMAT_OUT}`;

export interface MixLine {
  /** Where the line starts, in ms of demo time. */
  t: number;
  file: string;
  /** How long it lasts — what the music has to duck around. */
  durationMs?: number;
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
export interface MusicBed {
  file: string;
  /** Level before ducking, in dB relative to the file's own loudness. */
  gain: number;
  /** How far the bed drops while someone is speaking, in dB. Negative. */
  duck: number;
  fadeInMs: number;
  fadeOutMs: number;
}

/** Ramp into and out of a duck, so the bed leans away rather than jumping. */
const DUCK_RAMP_MS = 220;

/**
 * A gain envelope for the music, in ffmpeg expression form.
 *
 * The obvious way to duck a bed is `sidechaincompress`, keyed off the voice.
 * It is not used here because the spec offers a number in dB, and a compressor
 * cannot honour that: how far it pulls down depends on how loud the narrator
 * happened to be. `duck: -12` would mean "about twelve, sometimes", which is a
 * knob that lies.
 *
 * Reel knows exactly when every line starts and how long it lasts, so the
 * envelope can be written out directly and the number means what it says. It is
 * also purely a function of the timings, which keeps the mix reproducible.
 *
 * The shape per line is a trapezoid: down over DUCK_RAMP_MS before the line,
 * held for its duration, back up over the same ramp after. Overlapping lines
 * take the deepest duck rather than stacking, which two `max`es would otherwise
 * compound into silence.
 */
export function duckEnvelope(lines: MixLine[], durations: number[], duckDb: number): string {
  const ramp = DUCK_RAMP_MS / 1000;
  const k = 10 ** (duckDb / 20); // dB → linear floor
  const spans = lines
    .map((l, i) => [Math.max(0, l.t) / 1000, (Math.max(0, l.t) + (durations[i] ?? 0)) / 1000] as const)
    .filter(([s, e]) => e > s);
  if (spans.length === 0) return "1";

  // Each span contributes a 0..1 "how ducked are we" ramp; the envelope takes
  // the maximum, then maps 1 onto the floor.
  //
  // Negative numbers are parenthesised: a line starting at 0 puts the ramp's
  // origin below zero, and `t--0.220` only means the right thing by way of the
  // parser reading it as a subtracted negative. `(t-(-0.220))` says it outright.
  //
  // Commas are left unescaped. The expression reaches ffmpeg inside single
  // quotes, and that is what stops the filtergraph parser splitting on them.
  const n = (v: number) => (v < 0 ? `(${v.toFixed(3)})` : v.toFixed(3));
  const tri = ([s, e]: readonly [number, number]) =>
    `min(1,max(0,(t-${n(s - ramp)})/${ramp.toFixed(3)}))` +
    `*min(1,max(0,(${n(e + ramp)}-t)/${ramp.toFixed(3)}))`;
  const deepest = spans.map(tri).reduce((acc, x) => (acc ? `max(${acc},${x})` : x), "");
  return `1-${(1 - k).toFixed(4)}*(${deepest})`;
}

/**
 * Mix spoken lines — and optionally a music bed — into a single track of
 * exactly `durationMs`.
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
  music?: MusicBed,
  sfxFile?: string,
): Promise<void> {
  if (lines.length === 0 && !music && !sfxFile) {
    throw new ReelError("Nothing to mix — no spoken lines, no bed, no effects.");
  }
  const seconds = (durationMs / 1000).toFixed(3);

  const inputs = lines.flatMap((l) => ["-i", l.file]);
  const delayed = lines.map(
    (l, i) => `[${i}:a]${NORMALIZE},adelay=${Math.max(0, Math.round(l.t))}:all=1[d${i}]`,
  );

  // `amix` needs two or more inputs; a single-line demo is just the one stream.
  const merged =
    lines.length === 1
      ? "[d0]anull[m]"
      : `${lines.map((_, i) => `[d${i}]`).join("")}amix=inputs=${lines.length}:normalize=0:duration=longest[m]`;

  const graph: string[] = [...delayed];
  if (lines.length) graph.push(merged);

  let bus = lines.length ? "[m]" : "";
  if (music) {
    const mi = lines.length; // the bed is the input after the spoken lines
    const durations = lines.map((l) => l.durationMs ?? 0);
    const envelope = lines.length ? duckEnvelope(lines, durations, music.duck) : "1";
    const fadeOutAt = Math.max(0, durationMs - music.fadeOutMs) / 1000;
    graph.push(
      `[${mi}:a]${NORMALIZE},volume=${music.gain}dB,` +
        // eval=frame so the envelope is applied over time rather than once.
        `volume='${envelope}':eval=frame,` +
        `afade=t=in:st=0:d=${(music.fadeInMs / 1000).toFixed(3)},` +
        `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${(music.fadeOutMs / 1000).toFixed(3)},` +
        `atrim=0:${seconds}[bed]`,
    );
    if (lines.length) {
      graph.push(`[m][bed]amix=inputs=2:normalize=0:duration=longest[mixed]`);
      bus = "[mixed]";
    } else {
      bus = "[bed]";
    }
  }

  if (sfxFile) {
    // The effects arrive already mixed, placed and levelled — one stereo-safe
    // input rather than one per tick, which for a demo with fifty clicks is the
    // difference between a readable filter graph and an unreadable one. They
    // are deliberately not ducked: they are transient and quiet, and pulling
    // them down under the voice would leave the clicks that matter most, the
    // ones being talked over, inaudible.
    const si = lines.length + (music ? 1 : 0);
    graph.push(`[${si}:a]${NORMALIZE},atrim=0:${seconds}[fx]`);
    if (bus) {
      graph.push(`${bus}[fx]amix=inputs=2:normalize=0:duration=longest[withfx]`);
      bus = "[withfx]";
    } else {
      // Effects on their own — no narration, no bed. `amix` with one input is
      // an error, not a no-op, so the effects simply become the bus.
      bus = "[fx]";
    }
  }

  const sourceInputs = [
    ...inputs,
    // Looped so a short bed covers a long demo; the atrim above cuts it back.
    ...(music ? ["-stream_loop", "-1", "-i", music.file] : []),
    ...(sfxFile ? ["-i", sfxFile] : []),
  ];
  // Length first; format is pinned at the very end of each chain instead.
  const tail = `aresample=${SAMPLE_RATE},apad,atrim=0:${seconds}`;

  // Loudness is measured first and corrected with a constant gain, rather than
  // normalised in one pass.
  //
  // One-pass loudnorm is a *dynamic* processor: it rides the level, and with a
  // loudness-range target it actively compresses quiet passages upward. Run
  // over a mix that already carries a deliberate envelope, it lifts the bed
  // back up underneath the voice — a measured 11dB of ducking where the spec
  // asked for 15. Measuring first and then applying one fixed gain hits the
  // same target loudness while leaving every level relationship exactly where
  // the mix put it.
  const measured = await measureLoudness(sourceInputs, graph, bus, tail);

  const normalise =
    `${bus}${tail},loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}` +
    (measured
      ? `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
        `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}:linear=true`
      : "") +
    // `aformat` must be the last filter before the output, not merely present
    // somewhere upstream. loudnorm resamples internally and needs an
    // `aresample` after it to come back, and a bare resample leaves the layout
    // unpinned — so the encoder's own format filter has nothing to negotiate
    // against and the graph dies with "Cannot select channel layout", minutes
    // into a render, after the picture is already encoded. Some ffmpeg builds
    // are lenient enough to guess; the macOS one is not.
    `,aresample=${SAMPLE_RATE},${FORMAT_OUT}[out]`;

  await ffmpeg([
    "-y",
    ...sourceInputs,
    "-filter_complex",
    [...graph, normalise].join(";"),
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    BITRATE,
    // Output-side: `-map_metadata -1` belongs before the file it applies to.
    // Without these, ffmpeg stamps a fresh creation time into the container on
    // every run and the demo stops rendering the same bytes twice.
    ...BITEXACT,
    out,
  ]);
}

interface LoudnessStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/**
 * Measure the mix so the second pass can correct it with one fixed gain.
 *
 * Returns null when the numbers can't be read, and the caller falls back to a
 * single dynamic pass: a mix that is loud enough but slightly over-levelled
 * beats no soundtrack at all.
 */
async function measureLoudness(
  sourceInputs: string[],
  graph: string[],
  bus: string,
  tail: string,
): Promise<LoudnessStats | null> {
  const probe = `${bus}${tail},` +
    `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}:print_format=json,` +
    `${FORMAT_OUT}[out]`;
  const stderr = await ffmpegProbe([
    "-y",
    ...sourceInputs,
    "-filter_complex",
    [...graph, probe].join(";"),
    "-map",
    "[out]",
    "-f",
    "null",
    "-",
  ]);
  // The JSON is the last object printed; anything before it is progress noise.
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) {
    log.debug("Could not measure loudness — falling back to a single dynamic pass.");
    return null;
  }
  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnessStats>;
    if (!parsed.input_i || !parsed.target_offset) return null;
    return parsed as LoudnessStats;
  } catch {
    log.debug("Loudness measurement was not valid JSON — falling back to one pass.");
    return null;
  }
}

/**
 * Put an existing track onto an existing video, in place.
 *
 * The video is stream-copied, so this costs no quality and no re-encode — the
 * picture that was verified is bit-for-bit the picture that ships.
 */
export async function muxAudio(video: string, audio: string): Promise<void> {
  // Beside the video, so the rename below is a move within one filesystem.
  // Slicing at the last "/" put it in the cwd on Windows, where the separator
  // is a backslash — and renaming across volumes fails.
  const tmp = join(dirname(video), `.reel-mux-${Date.now().toString(36)}.mp4`);
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
      ...BITEXACT,
      tmp,
    ]);
    await rename(tmp, video);
    log.ok(`audio → ${video}`);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
