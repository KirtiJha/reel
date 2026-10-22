// Cut the advertisement.
//
//   node promo/cut.mjs            # assemble from promo/out/
//   node promo/cut.mjs --cards    # re-render the motion cards first
//
// ## What this is, and what promo/build.mjs is
//
// `build.mjs` records the chapters: nine specs driven against this repository,
// each one a real capture with Reel's own sound effects on it. That is the
// proof, and it does not change.
//
// This assembles those captures into something somebody will watch. The first
// cut was the chapters joined end to end, and seen as a contact sheet it was
// nine near-identical browser windows on a gradient — accurate, and
// documentation rather than an advertisement. What was missing was everything
// around the footage: an opener, statements between the sections, an end card,
// and cuts with some pace to them.
//
// So the captures are now b-roll between full-screen motion graphics
// (promo/motion), each chapter trimmed past its own title card because the
// cards replace them.
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const promoDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(promoDir, "..");
const outDir = join(promoDir, "out");
const cardsDir = join(outDir, "cards");
const workDir = join(promoDir, ".work");

const log = (m) => console.log(`\x1b[36m›\x1b[0m ${m}`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repo });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

function duration(file) {
  const r = spawnSync(ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr ?? "");
  if (!m) throw new Error(`no duration for ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** How long a cut overlaps the next one. Short: this is an ad, not a montage. */
const X = 0.4;

/**
 * The cut.
 *
 * `card` entries are full-frame motion graphics and play whole. `clip` entries
 * are captures: `from` skips each chapter's own Reel title card, which the
 * motion cards have replaced, and `len` is how long the shot runs.
 *
 * `punch` crops in before scaling to 1080p. The terminal chapters get it
 * because 96 columns of monospace in a window frame on a 1920-wide canvas is
 * small enough to lose on a phone; the browser chapters are already composed
 * for the frame and only get hurt by cropping.
 */
const CUT = [
  { card: "opener" },
  { clip: "01-hook.mp4", from: 3.2, len: 17.5, why: "the app being driven" },
  { card: "written" },
  { clip: "02-spec.mp4", from: 3.4, len: 18.5, punch: 1.2, why: "the spec, and check passing" },
  { card: "formats" },
  { clip: "03-formats.mp4", from: 3.6, len: 15.0, why: "tabs: gif / terminal / storyboard" },
  { card: "sound" },
  { clip: "04-sound.mp4", from: 3.6, len: 15.0, why: "the player, English then Spanish" },
  { card: "interactive" },
  { clip: "05-interactive.mp4", from: 3.6, len: 19.5, why: "stepping, then the branch" },
  { card: "ci", transition: "wiperight" },
  { clip: "06-ci.mp4", from: 3.6, len: 17.0, punch: 1.2, why: "the real failure" },
  { card: "bytes" },
  { clip: "07-reproducible.mp4", from: 3.4, len: 19.0, punch: 1.18, why: "two renders, one checksum" },
  { card: "studio" },
  { clip: "08-studio.mp4", from: 3.6, len: 17.0, why: "gallery into the spec" },
  { clip: "09-close.mp4", from: 3.6, len: 10.5, why: "the published site" },
  { card: "endcard" },
];

const wantCards = process.argv.includes("--cards");

await mkdir(workDir, { recursive: true });
await mkdir(cardsDir, { recursive: true });

if (wantCards) {
  for (const name of new Set(CUT.filter((s) => s.card).map((s) => s.card))) {
    log(`rendering card ${name}`);
    run(process.execPath, [join(promoDir, "motion", "render.mjs"), name, join(cardsDir, `${name}.mp4`)]);
  }
}

/* ------------------------------------------------------------- the inputs */

const items = CUT.map((s) => {
  if (s.card) {
    const file = join(cardsDir, `${s.card}.mp4`);
    if (!existsSync(file)) throw new Error(`missing card ${file} — run with --cards`);
    return { ...s, file, len: duration(file), from: 0 };
  }
  const file = join(outDir, s.clip);
  if (!existsSync(file)) throw new Error(`missing capture ${file} — run promo/build.mjs first`);
  const have = duration(file);
  if (s.from + s.len > have) throw new Error(`${s.clip} is ${have.toFixed(1)}s, cut wants ${(s.from + s.len).toFixed(1)}s`);
  return { ...s, file };
});

const total = items.reduce((a, s) => a + s.len, 0) - X * (items.length - 1);
log(`${items.length} shots, ${total.toFixed(1)}s after ${items.length - 1} transitions`);

const starts = [];
let at = 0;
for (const s of items) {
  starts.push(at);
  at += s.len - X;
}

/* ------------------------------------------------------------ the filters */

const filter = [];
items.forEach((s, i) => {
  // A punch is a centred crop before the scale, so the text lands bigger on
  // the finished frame rather than being resampled smaller.
  const crop = s.punch
    ? `crop=iw/${s.punch}:ih/${s.punch}:(iw-ow)/2:(ih-oh)/2,`
    : "";
  filter.push(
    `[${i}:v]trim=${s.from}:${(s.from + s.len).toFixed(3)},setpts=PTS-STARTPTS,` +
      `${crop}scale=1920:1080:flags=lanczos,format=yuv420p,setsar=1,fps=30[v${i}]`,
  );
});

let prev = "v0";
for (let i = 1; i < items.length; i++) {
  const label = i === items.length - 1 ? "vout" : `vx${i}`;
  const kind = items[i].transition ?? "fade";
  filter.push(`[${prev}][v${i}]xfade=transition=${kind}:duration=${X}:offset=${starts[i].toFixed(3)}[${label}]`);
  prev = label;
}

// Audio: the captures carry Reel's own sound effects, the cards are silent,
// and the score runs under all of it. Levels are the ones promo/build.mjs
// arrived at — the effects well down, because the track Reel muxes peaks near
// full scale and will otherwise bury the bed it is supposed to sit on.
const score = join(workDir, "score.wav");
if (!existsSync(score)) {
  log("synthesizing the score");
  run(process.execPath, [join(promoDir, "score.mjs"), score]);
}
items.forEach((s, i) => {
  const ms = Math.round(starts[i] * 1000);
  if (s.card) {
    filter.push(`anullsrc=r=48000:cl=stereo,atrim=0:${s.len.toFixed(3)},adelay=${ms}|${ms}[a${i}]`);
  } else {
    filter.push(
      `[${i}:a]atrim=${s.from}:${(s.from + s.len).toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume=-10dB,adelay=${ms}|${ms}[a${i}]`,
    );
  }
});
filter.push(
  `[${items.length}:a]atrim=0:${total.toFixed(3)},volume=-6dB,` +
    `afade=t=in:st=0:d=1.2,afade=t=out:st=${(total - 4.5).toFixed(3)}:d=4.5[score]`,
);
filter.push(
  `${items.map((_, i) => `[a${i}]`).join("")}[score]amix=inputs=${items.length + 1}:normalize=0:duration=longest,` +
    `alimiter=limit=0.82:level=disabled:attack=5:release=60[aout]`,
);

const filterFile = join(workDir, "cut.txt");
await writeFile(filterFile, filter.join(";\n"));

const master = join(outDir, "reel-ad.mp4");
await rm(master, { force: true });
log("cutting");
run(ffmpegPath, [
  "-y", "-hide_banner", "-loglevel", "error",
  ...items.flatMap((s) => ["-i", s.file]),
  "-i", score,
  "-filter_complex_script", filterFile,
  "-map", "[vout]", "-map", "[aout]",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
  "-movflags", "+faststart", "-t", total.toFixed(3),
  master,
]);

// One gain stage at the end. `alimiter` needs `level=disabled` or it
// normalises the limited signal straight back up to full scale, which is how
// an earlier cut of this shipped measuring +4.3 dBFS.
log("measuring loudness");
const measured = spawnSync(ffmpegPath, ["-hide_banner", "-nostats", "-i", master, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
// The LAST match: ebur128 prints a running `I:` on every progress line, and
// the first is the reading 100ms into a film that opens on a fade.
const all = [...(measured.stderr ?? "").matchAll(/I:\s+(-?\d+\.\d+) LUFS/g)];
const lufs = Number(all.at(-1)?.[1]);
const gain = -14 - lufs;
const final = join(outDir, "reel-ad-final.mp4");
await rm(final, { force: true });
if (Number.isFinite(lufs) && Math.abs(gain) > 0.5) {
  log(`mix is ${lufs} LUFS — applying ${gain.toFixed(2)} dB for YouTube's -14`);
  run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-i", master,
    "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.82:level=disabled:attack=5:release=60`,
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", final,
  ]);
} else {
  run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", master, "-c", "copy", "-movflags", "+faststart", final]);
}
log(`done → ${final}`);
