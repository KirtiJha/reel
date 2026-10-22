// Synthesize the promo's score, so the film needs no licensed audio checked in.
//
// Reel already synthesizes its UI sound (src/encode/sfx.ts) rather than
// shipping recordings — same reasoning here, scaled up to a four-minute cue:
// nothing to license, nothing to attribute, and the same bytes on every
// machine because every oscillator and every noise burst is seeded.
//
// Written as raw PCM in one pass rather than as an ffmpeg filter graph, for the
// reason sfx.ts gives: a few hundred notes would otherwise be a few hundred
// inputs and a few hundred `adelay`s. Summing samples into one buffer is
// simpler, faster, and a pure function of the arrangement below.
//
//   node promo/score.mjs [out.wav]

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SR = 48_000;
const BPM = 112;
const BEAT = 60 / BPM; // seconds
const BAR = BEAT * 4;
const BARS = 124; // ~4:25 at this tempo — trimmed to the film's length when mixed
const DURATION = BARS * BAR + 3;
const N = Math.ceil(DURATION * SR);

const L = new Float32Array(N);
const R = new Float32Array(N);

/* ---------------------------------------------------------------- helpers */

/** mulberry32 — the same seeded PRNG sfx.ts uses, for the same reason. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** MIDI note → Hz. 69 = A4 = 440. */
const hz = (n) => 440 * 2 ** ((n - 69) / 12);

/** Note names, so the arrangement below reads as music and not as integers. */
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const n = (name, octave) => NOTE[name] + (octave + 1) * 12;

/**
 * Add mono samples into the stereo bus at `pan` (-1..1), starting at `t`.
 *
 * Equal-power panning: a centred note and a hard-panned one carry the same
 * energy, which is what keeps the arpeggio from pumping as it alternates sides.
 */
function mix(buf, t, pan = 0, gain = 1) {
  const start = Math.round(t * SR);
  const theta = ((pan + 1) / 2) * (Math.PI / 2);
  const gl = Math.cos(theta) * gain;
  const gr = Math.sin(theta) * gain;
  for (let i = 0; i < buf.length; i++) {
    const j = start + i;
    if (j < 0 || j >= N) continue;
    L[j] += buf[i] * gl;
    R[j] += buf[i] * gr;
  }
}

/**
 * ADSR as a multiplier at sample `i` of `len`.
 *
 * Every voice goes through one. A sine that starts and stops at full scale
 * clicks, and a few hundred clicks is what makes synthesized music sound
 * synthesized.
 */
function env(i, len, { a = 0.005, d = 0.1, s = 0.7, r = 0.2 }) {
  const t = i / SR;
  const total = len / SR;
  const rStart = Math.max(a + d, total - r);
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < rStart) return s;
  const k = (t - rStart) / Math.max(r, 1e-6);
  return Math.max(0, s * (1 - k));
}

/** A 2-pole state-variable lowpass. Cheap, stable, and it has a resonance knob. */
function lowpass(buf, cutoff, q = 0.7) {
  const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR / 2.5)) / SR);
  let low = 0;
  let band = 0;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const high = buf[i] - low - q * band;
    band += f * high;
    low += f * band;
    out[i] = low;
  }
  return out;
}

function highpass(buf, cutoff, q = 0.7) {
  const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR / 2.5)) / SR);
  let low = 0;
  let band = 0;
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const high = buf[i] - low - q * band;
    band += f * high;
    low += f * band;
    out[i] = high;
  }
  return out;
}

/* ------------------------------------------------------------------ voices */

/** A soft saw, built from harmonics so it has no aliasing worth hearing. */
function saw(freq, len, partials = 12) {
  const out = new Float32Array(len);
  for (let p = 1; p <= partials; p++) {
    if (freq * p > SR / 2.2) break;
    const w = (2 * Math.PI * freq * p) / SR;
    const amp = 1 / p;
    for (let i = 0; i < len; i++) out[i] += Math.sin(w * i) * amp;
  }
  for (let i = 0; i < len; i++) out[i] *= 0.4;
  return out;
}

/**
 * The pad: three detuned saws per note, slow attack, lowpassed.
 *
 * The detune is what makes it a pad rather than an organ — three oscillators a
 * few cents apart beat against each other slowly, which reads as movement in a
 * chord that is otherwise completely static.
 */
function pad(midi, dur, { gain = 0.1, cutoff = 1800, pan = 0 } = {}) {
  const len = Math.round(dur * SR);
  const f = hz(midi);
  const out = new Float32Array(len);
  for (const cents of [-7, 0, 7]) {
    const v = saw(f * 2 ** (cents / 1200), len, 10);
    for (let i = 0; i < len; i++) out[i] += v[i] / 3;
  }
  const filtered = lowpass(out, cutoff, 1.1);
  for (let i = 0; i < len; i++) {
    filtered[i] *= env(i, len, { a: 0.5, d: 0.6, s: 0.75, r: Math.min(1.2, dur * 0.4) }) * gain;
  }
  return { buf: filtered, pan };
}

/** A plucked tone — triangle-ish, fast attack, exponential decay. */
function pluck(midi, dur, { gain = 0.1, pan = 0, bright = 1 } = {}) {
  const len = Math.round(dur * SR);
  const f = hz(midi);
  const out = new Float32Array(len);
  const w = (2 * Math.PI * f) / SR;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    // A touch of second and third harmonic, decaying faster than the
    // fundamental — the shape of something struck rather than blown.
    const body =
      Math.sin(w * i) +
      0.3 * bright * Math.sin(2 * w * i) * Math.exp(-t * 9) +
      0.14 * bright * Math.sin(3 * w * i) * Math.exp(-t * 15);
    out[i] = body * Math.exp(-t * 4.5) * env(i, len, { a: 0.003, d: 0.02, s: 0.9, r: 0.08 }) * gain;
  }
  return { buf: out, pan };
}

/** Sub bass: a sine with just enough harmonic to survive a phone speaker. */
function bass(midi, dur, { gain = 0.26 } = {}) {
  const len = Math.round(dur * SR);
  const f = hz(midi);
  const out = new Float32Array(len);
  const w = (2 * Math.PI * f) / SR;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    out[i] =
      (Math.sin(w * i) + 0.18 * Math.sin(2 * w * i) * Math.exp(-t * 6)) *
      env(i, len, { a: 0.008, d: 0.12, s: 0.72, r: 0.12 }) *
      gain;
  }
  return { buf: out, pan: 0 };
}

const rngKick = prng(0x1a2b);
const rngHat = prng(0x3c4d);
const rngClap = prng(0x5e6f);

/** Kick: a pitch sweep from 125Hz to 48Hz with a click on the front. */
function kick(gain = 0.5) {
  const len = Math.round(0.22 * SR);
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 48 + (125 - 48) * Math.exp(-t * 32);
    phase += (2 * Math.PI * f) / SR;
    const click = (rngKick() * 2 - 1) * Math.exp(-t * 320) * 0.25;
    out[i] = (Math.sin(phase) + click) * Math.exp(-t * 11) * gain;
  }
  return { buf: out, pan: 0 };
}

/**
 * Hat: a short burst of noise, band-limited at both ends.
 *
 * The top lowpass is not optional. Highpassed noise alone runs flat to Nyquist,
 * and what that sounds like is not a hi-hat but a hiss gated in time — on a
 * spectrogram it is a solid wash from 8k to 22k with no shape to it.
 */
function hat(gain = 0.055, dur = 0.045, pan = 0) {
  const len = Math.round(dur * SR);
  const raw = new Float32Array(len);
  for (let i = 0; i < len; i++) raw[i] = rngHat() * 2 - 1;
  const out = lowpass(highpass(raw, 7600, 0.8), 13500, 0.7);
  for (let i = 0; i < len; i++) out[i] *= Math.exp(-(i / SR) * 90) * gain * 1.35;
  return { buf: out, pan };
}

/** Clap: three noise bursts a few milliseconds apart, then a tail. */
function clap(gain = 0.17) {
  const len = Math.round(0.26 * SR);
  const raw = new Float32Array(len);
  for (let i = 0; i < len; i++) raw[i] = rngClap() * 2 - 1;
  const body = lowpass(highpass(raw, 1100, 0.7), 5200, 0.8);
  const out = new Float32Array(len);
  const taps = [0, 0.011, 0.023];
  for (const tap of taps) {
    const off = Math.round(tap * SR);
    for (let i = 0; i + off < len; i++) out[i + off] += body[i] * Math.exp(-(i / SR) * 55) * 0.5;
  }
  for (let i = 0; i < len; i++) out[i] += body[i] * Math.exp(-(i / SR) * 11) * 0.22;
  for (let i = 0; i < len; i++) out[i] *= gain;
  return { buf: out, pan: 0 };
}

/* ------------------------------------------------------------- arrangement */

// vi–IV–I–V in A minor: the progression is doing nothing clever on purpose.
// This is a bed under a product film, and the job of a bed is to carry four
// minutes without ever asking to be listened to.
const PROG = [
  { root: n("A", 2), chord: [n("A", 3), n("C", 4), n("E", 4)], arp: [n("A", 4), n("C", 5), n("E", 5), n("C", 5)] },
  { root: n("F", 2), chord: [n("F", 3), n("A", 3), n("C", 4)], arp: [n("F", 4), n("A", 4), n("C", 5), n("A", 4)] },
  { root: n("C", 3), chord: [n("C", 4), n("E", 4), n("G", 4)], arp: [n("C", 5), n("E", 5), n("G", 5), n("E", 5)] },
  { root: n("G", 2), chord: [n("G", 3), n("B", 3), n("D", 4)], arp: [n("G", 4), n("B", 4), n("D", 5), n("B", 4)] },
];

/** A melody that states itself, answers itself, and then gets out of the way. */
const MOTIF = [
  [0, n("E", 5), 1.5], [1.5, n("C", 5), 0.5], [2, n("D", 5), 1], [3, n("A", 4), 1],
  [4, n("F", 5), 1.5], [5.5, n("E", 5), 0.5], [6, n("C", 5), 2],
  [8, n("G", 5), 1.5], [9.5, n("E", 5), 0.5], [10, n("D", 5), 1], [11, n("E", 5), 1],
  [12, n("C", 5), 2], [14, n("A", 4), 2],
];

/**
 * What is playing when.
 *
 * A four-minute bed that never changes is worse than silence, and a four-minute
 * bed that changes every eight bars is a song competing with the film. These
 * are the four levers — low, mid, high, and the tune — moved slowly.
 */
function arrangement(bar) {
  if (bar < 6) return { pad: 0.85, bass: 0, arp: 0, drums: 0, motif: 0, cutoff: 900 };
  if (bar < 14) return { pad: 1, bass: 0.7, arp: 0.5, drums: 0, motif: 0, cutoff: 1500 };
  if (bar < 28) return { pad: 1, bass: 1, arp: 0.85, drums: 0.7, motif: 0, cutoff: 2200 };
  if (bar < 44) return { pad: 1, bass: 1, arp: 1, drums: 1, motif: 0.9, cutoff: 2800 };
  if (bar < 52) return { pad: 0.95, bass: 0.45, arp: 0.6, drums: 0, motif: 0, cutoff: 1300 }; // breakdown
  if (bar < 68) return { pad: 1, bass: 1, arp: 0.9, drums: 0.85, motif: 0, cutoff: 2400 };
  if (bar < 88) return { pad: 1, bass: 1, arp: 1, drums: 1, motif: 1, cutoff: 3000 };
  if (bar < 104) return { pad: 1, bass: 1, arp: 1, drums: 1, motif: 0.8, cutoff: 3200 }; // lift
  if (bar < 114) return { pad: 1, bass: 0.9, arp: 0.8, drums: 0.6, motif: 0.5, cutoff: 2200 };
  return { pad: 0.9, bass: 0.4, arp: 0.35, drums: 0, motif: 0, cutoff: 1200 }; // outro
}

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR;
  const a = arrangement(bar);
  const step = PROG[bar % PROG.length];

  // Pad — one sustained chord per bar, voices spread across the stereo field.
  if (a.pad > 0) {
    step.chord.forEach((note, i) => {
      const { buf, pan } = pad(note, BAR * 1.05, {
        gain: 0.085 * a.pad,
        cutoff: a.cutoff,
        pan: [-0.45, 0, 0.45][i] ?? 0,
      });
      mix(buf, t0, pan);
    });
  }

  // Bass — root on 1 and on the "and" of 3, which is enough to imply a groove
  // without writing one.
  if (a.bass > 0) {
    for (const [beat, dur] of [[0, BEAT * 1.6], [2.5, BEAT * 1.2]]) {
      const { buf } = bass(step.root, dur, { gain: 0.24 * a.bass });
      mix(buf, t0 + beat * BEAT, 0);
    }
  }

  // Arpeggio — straight eighths, alternating sides.
  if (a.arp > 0) {
    for (let e = 0; e < 8; e++) {
      const note = step.arp[e % step.arp.length] + (e >= 4 ? 12 : 0);
      const { buf, pan } = pluck(note, BEAT * 0.75, {
        gain: 0.055 * a.arp * (e % 2 === 0 ? 1 : 0.72),
        pan: e % 2 === 0 ? -0.35 : 0.35,
        bright: 1,
      });
      mix(buf, t0 + e * BEAT * 0.5, pan);
    }
  }

  // Drums.
  if (a.drums > 0) {
    for (const beat of [0, 2, 2.75]) mix(kick(0.46 * a.drums).buf, t0 + beat * BEAT, 0);
    for (const beat of [1, 3]) mix(clap(0.16 * a.drums).buf, t0 + beat * BEAT, 0);
    for (let e = 0; e < 8; e++) {
      const accent = e % 2 === 1 ? 1 : 0.55;
      mix(hat(0.05 * a.drums * accent).buf, t0 + e * BEAT * 0.5, e % 2 ? 0.25 : -0.25);
    }
  }

  // Motif — a 16-beat phrase, so it only lands on every fourth bar boundary.
  if (a.motif > 0 && bar % 4 === 0) {
    for (const [beat, note, dur] of MOTIF) {
      const { buf, pan } = pluck(note, dur * BEAT * 0.9, {
        gain: 0.062 * a.motif,
        pan: 0.1,
        bright: 0.55,
      });
      mix(buf, t0 + beat * BEAT, pan);
    }
  }
}

/* ------------------------------------------------------------------ master */

/**
 * A dotted-eighth feedback delay, ping-ponged.
 *
 * The one effect that does most of the work: it glues the arpeggio to the pad
 * and gives a completely dry synthetic mix the impression of a room.
 */
function pingPongDelay(time, feedback, wet) {
  const d = Math.round(time * SR);
  for (let i = d; i < N; i++) {
    L[i] += R[i - d] * feedback * wet;
    R[i] += L[i - d] * feedback * wet * 0.92;
  }
}
pingPongDelay(BEAT * 0.75, 0.34, 0.5);

/** A cheap reverb: a handful of lowpassed taps at prime-ish offsets. */
function reverb(wet) {
  const taps = [0.029, 0.041, 0.057, 0.073, 0.094, 0.113];
  const sendL = lowpass(L, 3400, 0.7);
  const sendR = lowpass(R, 3400, 0.7);
  taps.forEach((tap, k) => {
    const d = Math.round(tap * SR);
    const g = (wet * 0.5) / (k + 1.4);
    for (let i = d; i < N; i++) {
      L[i] += sendR[i - d] * g;
      R[i] += sendL[i - d] * g;
    }
  });
}
reverb(0.4);

// Fade the very top and tail so the file can be laid under a film without
// either end announcing itself.
const fadeIn = Math.round(2.2 * SR);
const fadeOut = Math.round(5 * SR);
for (let i = 0; i < fadeIn; i++) {
  const g = i / fadeIn;
  L[i] *= g;
  R[i] *= g;
}
for (let i = 0; i < fadeOut; i++) {
  const g = i / fadeOut;
  L[N - 1 - i] *= g;
  R[N - 1 - i] *= g;
}

/**
 * Normalise, then soft-clip.
 *
 * `tanh` rather than a hard ceiling: the peaks here are the kick and the clap
 * landing together, and rounding those over sounds like a mix bus while
 * clipping them sounds like a mistake.
 */
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0 ? 0.92 / peak : 1;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * norm * 1.08) * 0.94;
  R[i] = Math.tanh(R[i] * norm * 1.08) * 0.94;
}

/* -------------------------------------------------------------------- file */

const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "score.wav");
const bytes = Buffer.alloc(44 + N * 4);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(36 + N * 4, 4);
bytes.write("WAVE", 8);
bytes.write("fmt ", 12);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); // PCM
bytes.writeUInt16LE(2, 22); // stereo
bytes.writeUInt32LE(SR, 24);
bytes.writeUInt32LE(SR * 4, 28);
bytes.writeUInt16LE(4, 32);
bytes.writeUInt16LE(16, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}
writeFileSync(out, bytes);
console.log(`wrote ${out} — ${(N / SR).toFixed(1)}s, ${BPM} BPM, ${BARS} bars`);
