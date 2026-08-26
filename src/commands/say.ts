import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadSpec } from "../spec/load.js";
import { voiceCacheDir } from "../narrate/audio.js";
import { synthesizeAll } from "../narrate/voice.js";
import { voiceSchema, type Voice } from "../spec/schema.js";
import { probeDurationMs } from "../encode/audio.js";
import { log, ReelError } from "../util/log.js";

export interface SayOptions {
  /** A spec to borrow the voice from, so a line sounds like the demo it is for. */
  spec?: string;
  /** Copy the audio here instead of leaving it in the cache. */
  out?: string;
  /** How many words a minute the estimate assumes, for `--dry-run`. */
  dryRun?: boolean;
}

export interface SayResult {
  text: string;
  durationMs: number;
  file?: string;
  cached: boolean;
  estimated?: boolean;
}

/**
 * Rough speaking rate for the estimate, in words per minute.
 *
 * Deliberately conservative: the number exists to catch a line that is far too
 * long before you pay to hear it, and over-estimating a borderline line is a
 * cheaper mistake than under-estimating one.
 */
const WORDS_PER_MINUTE = 150;

/**
 * Hear one line, or find out how long it runs.
 *
 * The gap this fills: narration length is the single thing about a demo that
 * cannot be judged by reading it. A sentence that scans well on the page can
 * take nine seconds to say, and today the only way to find that out is to
 * render the whole film and watch the picture wait for it.
 *
 * Cheap because of the cache. A line already spoken in a render costs nothing
 * and returns instantly; a new one is synthesized once and is then free for the
 * render that follows, so trying a line out is not work thrown away.
 *
 * `--dry-run` needs no key and no network at all — it estimates from the word
 * count, which is enough to catch the sentence that is obviously too long.
 */
export async function say(text: string, opts: SayOptions = {}): Promise<SayResult> {
  const line = text.trim();
  if (!line) {
    throw new ReelError("Nothing to say.", 'Pass the line as an argument: reel say "…"');
  }

  if (opts.dryRun) {
    const words = line.split(/\s+/).filter(Boolean).length;
    const durationMs = Math.round((words / WORDS_PER_MINUTE) * 60_000);
    log.info(`${words} words — about ${(durationMs / 1000).toFixed(1)}s at ${WORDS_PER_MINUTE}wpm.`);
    return { text: line, durationMs, cached: false, estimated: true };
  }

  // A line has no sound of its own: the voice is a property of the demo it
  // belongs to. Borrowing the spec's voice is what makes this a preview of the
  // real thing rather than a sample in some other voice.
  const { voice, dir } = await voiceFor(opts.spec);
  const cacheDir = voiceCacheDir(dir);

  const before = Date.now();
  const result = await synthesizeAll([line], voice, cacheDir);
  const file = result.files.get(line);
  if (!file) throw new ReelError("The voice provider returned no audio for that line.");
  const cached = result.cached > 0;

  const durationMs = await probeDurationMs(file);
  log.ok(
    `${(durationMs / 1000).toFixed(1)}s — ${cached ? "from the cache" : "synthesized"}` +
      (cached ? "" : ` in ${((Date.now() - before) / 1000).toFixed(1)}s`),
  );
  log.info(file);

  if (opts.out) {
    const target = resolve(opts.out);
    await copyFile(file, target);
    log.ok(`Copied to ${target}`);
    return { text: line, durationMs, file: target, cached };
  }
  return { text: line, durationMs, file, cached };
}

/**
 * The voice to speak in: the spec's own when one is named, else the default.
 *
 * The cache directory follows the spec too. A line tried out for a demo lands
 * in that demo's cache, so the render that follows finds it already there —
 * which is the difference between trying a line out and doing the work twice.
 */
async function voiceFor(specPath?: string): Promise<{ voice: Voice; dir: string }> {
  // Through the schema rather than an empty object cast to the type: the
  // provider and model are *defaults in the schema*, so a hand-built voice
  // arrives with `provider: undefined` and fails as "unknown provider" — an
  // error about a value the user never wrote.
  const fallback = voiceSchema.parse({});
  if (!specPath) return { voice: fallback, dir: process.cwd() };
  const loaded = await loadSpec(specPath);
  const voice = loaded.spec.audio?.voice;
  if (!voice) {
    log.warn(`${loaded.spec.name} has no \`audio.voice\` — using the default voice.`);
  }
  return { voice: voice ?? fallback, dir: dirname(loaded.path) };
}
