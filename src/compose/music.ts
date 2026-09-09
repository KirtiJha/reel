import { SFX_SAMPLE_RATE } from "../encode/sfx.js";

/**
 * A music bed, synthesized.
 *
 * ## Why synthesize rather than ship a track
 *
 * The same argument the sound effects already make, and it is a stronger one
 * for music. A recording needs a licence, and a licence that is right for
 * Reel's repository is not necessarily right for the demo you cut with it —
 * "royalty-free" covers a dozen incompatible things, and the person who finds
 * out it did not cover theirs finds out from a takedown. None of this is a
 * recording, so there is nothing to clear.
 *
 * It is also deterministic and offline, which the rest of the render already
 * has to be, and it costs a few hundred kilobytes rather than a few megabytes.
 *
 * ## What it is
 *
 * A slow pad: four voices per chord, sine partials with a little detune, moving
 * through a four-chord loop with long crossfades. Deliberately plain. A bed
 * under a product demo has one job, which is to stop the silence being the
 * loudest thing in the room; anything with an opinion competes with the
 * narration and wins.
 *
 * If you want real music, `reel compose --music track.mp3` takes a file and
 * this never runs.
 */

/**
 * Semitone offsets from the root for each chord in the loop.
 *
 * Voiced upward rather than around the root. The first version spanned -7 to
 * +12 from a 110Hz root, which put every partial that mattered under 200Hz — a
 * spectrogram of it is a single band along the bottom. That is a rumble, not a
 * bed: inaudible on a laptop speaker and gone entirely on a phone.
 */
const PROGRESSION = [
  [0, 7, 12, 16], // i
  [-4, 3, 8, 12], // VI
  [-5, 4, 7, 12], // III
  [-7, 2, 5, 11], // VII
];

/** Seconds per chord. Slow enough that nothing sounds like a rhythm. */
const CHORD = 8;
/**
 * Root of the pad, in Hz.
 *
 * A3 rather than A2. The bed still sits below the fundamental of most speech,
 * but its harmonics reach the range small speakers can actually reproduce.
 */
const ROOT = 220;
/**
 * Peak amplitude before the film's own mix. Quiet by design.
 *
 * 0.26 lands the bed near -25 dB mean, which the composition then plays at
 * `data-volume` 0.55 — roughly -30 dB in the mix, and about 12 dB below that
 * again while a line is speaking. Quiet is the safe direction to be wrong in:
 * a bed nobody notices is doing its job, and one that has to be turned down is
 * not.
 */
const LEVEL = 0.26;

const semitone = (n: number): number => ROOT * Math.pow(2, n / 12);

/**
 * One voice: a sine with two quiet upper partials and a slow detune beat.
 *
 * The detune is what keeps a sustained chord from sounding like a test tone —
 * two oscillators a fraction of a hertz apart drift in and out of phase, which
 * the ear reads as movement rather than as an artefact.
 */
function voice(t: number, hz: number): number {
  const w = 2 * Math.PI * t;
  return (
    Math.sin(w * hz) * 0.5 +
    Math.sin(w * hz * 1.0007) * 0.3 +
    // Enough upper partial to survive a laptop speaker, not enough to compete
    // with a voice: the bed should be felt before it is noticed.
    Math.sin(w * hz * 2) * 0.16 +
    Math.sin(w * hz * 3) * 0.08 +
    Math.sin(w * hz * 4) * 0.03
  );
}

/** Equal-power crossfade weight, so two overlapping chords keep a steady level. */
function fade(x: number): number {
  return Math.sin((Math.min(1, Math.max(0, x)) * Math.PI) / 2);
}

/**
 * Render a bed of exactly `durationMs`, with its own fade in and out.
 *
 * Pure in `t`: the sample at a given instant depends on nothing but that
 * instant, so this is as reproducible as the rest of the render.
 */
export function renderMusic(durationMs: number, sampleRate = SFX_SAMPLE_RATE): Float32Array {
  const total = Math.max(0, Math.round((durationMs / 1000) * sampleRate));
  const out = new Float32Array(total);
  if (total === 0) return out;

  const seconds = durationMs / 1000;
  // Long enough to be unmistakably deliberate at both ends.
  const rampIn = Math.min(2.5, seconds / 4);
  const rampOut = Math.min(3.5, seconds / 3);

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const pos = t / CHORD;
    const index = Math.floor(pos);
    const within = pos - index;

    // Chords overlap by a quarter of their length; outside that only one plays.
    const a = PROGRESSION[index % PROGRESSION.length]!;
    const b = PROGRESSION[(index + 1) % PROGRESSION.length]!;
    const cross = within > 0.75 ? (within - 0.75) / 0.25 : 0;

    let sample = 0;
    for (const n of a) sample += voice(t, semitone(n)) * fade(1 - cross);
    if (cross > 0) for (const n of b) sample += voice(t, semitone(n)) * fade(cross);
    sample /= a.length;

    const env =
      Math.min(1, t / rampIn) * Math.min(1, Math.max(0, (seconds - t) / rampOut));
    out[i] = Math.tanh(sample * LEVEL * env);
  }
  return out;
}
