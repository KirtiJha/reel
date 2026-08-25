// Synthesize a music bed, so the example needs no licensed audio checked in.
//
// A slow three-note pad with a little movement — enough to hear the ducking
// work against something musical rather than against a test tone. Replace
// bed.mp3 with anything you have the rights to; the spec only names the file.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ffmpeg from "ffmpeg-static";

const out = join(dirname(fileURLToPath(import.meta.url)), "bed.mp3");

// ffmpeg's `sine` source is not full-scale: it generates at 1/8 amplitude,
// which is 18 dB below where reading `volume=0.5` suggests the note sits. Left
// uncompensated the bed came out peaking at -26 dBFS, the spec's own
// `gain: -20` put it 20 dB below that, and the result was a music bed nobody
// could hear ducking under a voice — the one thing this example exists to
// demonstrate. Scaling each note back to full scale first is what makes the
// three levels below mean what they say.
const FULL_SCALE = 8;
const note = (input, level) => `[${input}:a]volume=${level * FULL_SCALE}`;

execFileSync(ffmpeg, [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=196:duration=30",
  "-f", "lavfi", "-i", "sine=frequency=294:duration=30",
  "-f", "lavfi", "-i", "sine=frequency=392:duration=30",
  "-filter_complex",
  `${note(0, 0.5)}[a];${note(1, 0.35)}[b];${note(2, 0.25)}[c];` +
    "[a][b][c]amix=inputs=3:normalize=0,tremolo=f=0.25:d=0.4,lowpass=f=1200,volume=0.4[out]",
  "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "160k", out,
]);
console.log(`wrote ${out}`);
