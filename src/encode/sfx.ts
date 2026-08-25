/**
 * Sound design, synthesized rather than shipped.
 *
 * A tick when something is clicked, key texture while text is typed, a low
 * sweep as a title card comes and goes. It is a small thing that does most of
 * the work of making a demo feel produced rather than screen-captured — and
 * unlike a music bed it needs no licensing, because none of it is a recording.
 * Every sample here is generated from oscillators and shaped noise.
 *
 * Built as raw PCM in one pass rather than as an ffmpeg filter graph. A demo
 * with fifty clicks would otherwise mean fifty inputs and fifty `adelay`s, and
 * summing samples into one buffer is both simpler and faster than asking ffmpeg
 * to do it. It also makes the whole thing a pure function, which is the only
 * way to be sure a soundtrack renders the same bytes twice.
 */

export const SFX_SAMPLE_RATE = 48_000;

/** What a step sounded like. */
export type SfxKind = "click" | "type" | "card";

export interface SfxCue {
  t: number;
  kind: SfxKind;
  /** For `type`, how long the typing ran — the ticks are spread across it. */
  durationMs?: number;
}

/** How present the effects are. `none` skips the track entirely. */
export type SfxProfile = "none" | "subtle" | "full";

/**
 * Peak level per kind, in dBFS, before the profile's own trim.
 *
 * Quiet on purpose. These sit under a voice and a music bed, and the moment a
 * UI tick is loud enough to notice on its own it has stopped being texture and
 * started being a distraction.
 */
const LEVELS: Record<SfxKind, number> = { click: -20, type: -30, card: -24 };

/** `full` is the reference; `subtle` is the same set, further down and sparser. */
const PROFILE_TRIM: Record<Exclude<SfxProfile, "none">, number> = { subtle: -8, full: 0 };

/** Milliseconds between key ticks while typing. */
const KEY_INTERVAL_MS = 85;

/**
 * A small deterministic PRNG (mulberry32).
 *
 * `Math.random()` would make every render's noise different, and noise is most
 * of what a click is. Seeded per sample kind so the same tick is the same tick
 * on every machine, every run.
 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/**
 * One effect, as mono samples.
 *
 * Each is a shaped burst rather than a loop: an envelope over a mix of tone and
 * noise. The shapes are chosen to read at low level against speech — short and
 * bright for a click, shorter and duller for a keystroke, long and low for a
 * card so it reads as movement rather than as an event.
 */
export function synthesize(kind: SfxKind): Float32Array {
  switch (kind) {
    case "click": {
      // 22ms: a hard attack, a little tone around 2.4kHz for definition, and a
      // fast exponential decay so it reads as a tap and not a beep.
      const n = Math.round(SFX_SAMPLE_RATE * 0.022);
      const out = new Float32Array(n);
      const rnd = prng(0x63_6c_6b_31);
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const env = Math.exp(-18 * p);
        const tone = Math.sin(2 * Math.PI * 2400 * (i / SFX_SAMPLE_RATE));
        const noise = rnd() * 2 - 1;
        out[i] = env * (0.65 * tone + 0.35 * noise);
      }
      return normalize(out);
    }
    case "type": {
      // 12ms, duller and noisier: a fingertip on a key, not a UI chime.
      const n = Math.round(SFX_SAMPLE_RATE * 0.012);
      const out = new Float32Array(n);
      const rnd = prng(0x6b_65_79_31);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        const env = Math.exp(-26 * p);
        // A one-pole low-pass takes the fizz off white noise and leaves a thud.
        lp += 0.35 * (rnd() * 2 - 1 - lp);
        const tone = Math.sin(2 * Math.PI * 900 * (i / SFX_SAMPLE_RATE));
        out[i] = env * (0.35 * tone + 0.65 * lp);
      }
      return normalize(out);
    }
    case "card": {
      // 380ms: noise swept downward through a moving low-pass, with a soft
      // attack. Long enough to feel like a transition rather than a hit.
      const n = Math.round(SFX_SAMPLE_RATE * 0.38);
      const out = new Float32Array(n);
      const rnd = prng(0x63_61_72_64);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const p = i / n;
        // Rise over the first 12%, then fall away.
        const env = p < 0.12 ? p / 0.12 : Math.exp(-4.5 * (p - 0.12));
        // Coefficient falls with time: bright at the start, dark by the end.
        const k = 0.22 * (1 - p) + 0.02;
        lp += k * (rnd() * 2 - 1 - lp);
        const sweep = Math.sin(2 * Math.PI * (320 - 220 * p) * (i / SFX_SAMPLE_RATE));
        out[i] = env * (0.45 * sweep + 0.55 * lp);
      }
      return normalize(out);
    }
  }
}

/** Scale to unit peak, so the level table means what it says. */
function normalize(buf: Float32Array): Float32Array {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return buf;
  for (let i = 0; i < buf.length; i++) buf[i]! /= peak;
  return buf;
}

/**
 * Expand cues into individual hits.
 *
 * A `type` step is one cue covering the whole burst of typing, which becomes a
 * run of key ticks across its duration — a tick per keystroke would mean
 * threading per-character timing through the driver for no audible gain.
 */
export function placeHits(cues: SfxCue[], profile: Exclude<SfxProfile, "none">): SfxCue[] {
  const hits: SfxCue[] = [];
  for (const c of cues) {
    if (c.kind !== "type") {
      hits.push({ t: c.t, kind: c.kind });
      continue;
    }
    // `subtle` halves the rate so typing reads as texture rather than a rattle.
    const step = KEY_INTERVAL_MS * (profile === "subtle" ? 2 : 1);
    const span = Math.max(0, c.durationMs ?? 0);
    for (let at = 0; at < span; at += step) hits.push({ t: c.t + at, kind: "type" });
  }
  return hits.sort((a, b) => a.t - b.t);
}

/**
 * Sum every hit into one mono track of exactly `durationMs`.
 *
 * Hits are added, not replaced, so two effects landing together reinforce
 * rather than cut each other off; the result is soft-clipped in case they pile
 * up past full scale.
 */
export function renderSfx(cues: SfxCue[], durationMs: number, profile: SfxProfile): Float32Array {
  const total = Math.max(0, Math.round((durationMs / 1000) * SFX_SAMPLE_RATE));
  const track = new Float32Array(total);
  if (profile === "none" || total === 0) return track;

  const trim = dbToGain(PROFILE_TRIM[profile]);
  const cache = new Map<SfxKind, Float32Array>();

  for (const hit of placeHits(cues, profile)) {
    const sample = cache.get(hit.kind) ?? synthesize(hit.kind);
    cache.set(hit.kind, sample);
    const gain = dbToGain(LEVELS[hit.kind]) * trim;
    const start = Math.round((Math.max(0, hit.t) / 1000) * SFX_SAMPLE_RATE);
    // A hit that would run past the end is truncated rather than dropped: the
    // attack is the part that matters and it has already landed.
    const n = Math.min(sample.length, total - start);
    for (let i = 0; i < n; i++) track[start + i]! += sample[i]! * gain;
  }

  for (let i = 0; i < total; i++) track[i] = Math.tanh(track[i]!);
  return track;
}

/** Mono 16-bit PCM WAV, the plainest thing ffmpeg will read without guessing. */
export function toWav(samples: Float32Array, sampleRate = SFX_SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    // Asymmetric on purpose: 16-bit two's complement reaches -32768 but only
    // +32767, and rounding the positive side to 32768 wraps to full-scale
    // negative — an audible tick exactly where the signal was loudest.
    data.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
