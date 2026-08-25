// The music bed for the product tour.
//
// Reel ships no music on purpose — bundling tracks is a licensing liability,
// and a bundled bed would be instantly recognisable across everyone's demos.
// So this one is synthesized: an A-minor pad, slow enough to sit under a voice
// without competing with it, and long enough that Reel's loop of it never
// seams audibly inside a chapter.
//
//   node demo/bed.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ffmpeg from "ffmpeg-static";

const out = join(dirname(fileURLToPath(import.meta.url)), "bed.mp3");

// ffmpeg's `sine` source generates at 1/8 amplitude, 18 dB below where reading
// `volume=0.5` suggests the note sits. Scaling back to full scale first is what
// makes the levels below mean what they say — the bug that made the narrated
// example's bed inaudible.
const FULL_SCALE = 8;

// A minor, voiced low and wide. The fifth and the octave carry the body; the
// third is quiet, because a prominent third makes a pad sound like a chord
// being played at you rather than a room tone.
const NOTES = [
  { hz: 110.0, level: 0.5 }, // A2 — root
  { hz: 164.81, level: 0.3 }, // E3 — fifth
  { hz: 220.0, level: 0.22 }, // A3 — octave
  { hz: 261.63, level: 0.14 }, // C4 — minor third, kept back
  { hz: 329.63, level: 0.1 }, // E4 — air
];

const SECONDS = 120;

const inputs = NOTES.flatMap((n) => ["-f", "lavfi", "-i", `sine=frequency=${n.hz}:duration=${SECONDS}`]);
const gains = NOTES.map((n, i) => `[${i}:a]volume=${(n.level * FULL_SCALE).toFixed(3)}[n${i}]`).join(";");
const mix = NOTES.map((_, i) => `[n${i}]`).join("");

execFileSync(ffmpeg, [
  "-y", "-loglevel", "error",
  ...inputs,
  "-filter_complex",
  `${gains};${mix}amix=inputs=${NOTES.length}:normalize=0,` +
    // Slow amplitude drift, so the pad breathes instead of droning.
    "tremolo=f=0.12:d=0.22," +
    // Two short reflections put it in a room. Without this it reads as a test
    // tone no matter how it is voiced.
    "aecho=0.8:0.85:180|340:0.28|0.18," +
    // Everything above speech territory comes off: the bed's job is to fill
    // underneath the voice, not to share the band with it.
    "lowpass=f=1100," +
    "volume=0.35[out]",
  "-map", "[out]",
  "-c:a", "libmp3lame", "-b:a", "192k", out,
]);
console.log(`wrote ${out}`);
