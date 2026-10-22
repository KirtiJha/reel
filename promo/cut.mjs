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
 * There is no `punch` on the terminal chapters, though the small monospace
 * invites one. A centred crop takes equal bites out of both sides, and
 * terminal text is left-aligned against a window frame that is already close
 * to the edge — at 1.2x it ate the prompt, turning "~/demos $ cat ..." into
 * "os $ cat ..." and "# yaml-language-server:" into "l-language-server:".
 * Slightly small and whole beats larger and truncated.
 */
const CUT = [
  { card: "opener" },
  { clip: "01-hook.mp4", from: 3.2, len: 17.5, why: "the app being driven" },
  { card: "written" },
  { clip: "02-spec.mp4", from: 3.4, len: 18.5, why: "the spec, and check passing" },
  { card: "formats" },
  { clip: "03-formats.mp4", from: 3.6, len: 15.0, why: "tabs: gif / terminal / storyboard" },
  { card: "sound" },
  { clip: "04-sound.mp4", from: 3.6, len: 15.0, why: "the player, English then Spanish" },
  { card: "interactive" },
  { clip: "05-interactive.mp4", from: 3.6, len: 19.5, why: "stepping, then the branch" },
  { card: "ci", transition: "wiperight" },
  { clip: "06-ci.mp4", from: 3.6, len: 17.0, why: "the real failure" },
  { card: "bytes" },
  { clip: "07-reproducible.mp4", from: 3.4, len: 19.0, why: "two renders, one checksum" },
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

/* --------------------------------------------------------------- the cut */

/**
 * Cut in pieces, then concatenate.
 *
 * The obvious way to do this is one ffmpeg invocation with every shot as an
 * input and a chain of `xfade` filters between them. That was the first
 * attempt and the kernel killed it at 13 GB: `xfade` has to buffer its first
 * input until it reaches the transition's offset, and seventeen of them nested
 * means the back half of the film is held in memory while the front half
 * plays.
 *
 * So each shot's body is cut on its own, each 0.4s transition is cut on its
 * own from just the two clips it joins, and the lot is concatenated by stream
 * copy. Nothing ever has more than two inputs open, and because every piece is
 * encoded with identical parameters the join costs nothing and re-encodes
 * nothing.
 */
const V = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30"];
const A = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

/** Normalise any shot to the film's frame: optional punch, then 1080p. */
const vchain = (s) =>
  (s.punch ? `crop=iw/${s.punch}:ih/${s.punch}:(iw-ow)/2:(ih-oh)/2,` : "") +
  "scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,fps=30";

/**
 * A card has no sound of its own and a capture has Reel's effects on it, but
 * both have to leave here with the same stream layout or the concat refuses
 * them. The silence is generated inside the filter graph rather than as a
 * second `anullsrc` input: as an input it reached EOF before the encoder had
 * been opened, and ffmpeg's complaint about that ("Could not open encoder
 * before EOF") does not name the cause.
 */
const asrc = (s, dur, label) =>
  s.card
    ? `anullsrc=r=48000:cl=stereo,atrim=0:${dur.toFixed(3)},asetpts=N/SR/TB[${label}]`
    : null;

const pieces = [];
for (let i = 0; i < items.length; i++) {
  const s = items[i];
  const headCut = i === 0 ? 0 : X; // consumed by the transition coming in
  const tailCut = i === items.length - 1 ? 0 : X; // consumed by the one going out
  const bodyFrom = s.from + headCut;
  const bodyLen = s.len - headCut - tailCut;
  const out = join(workDir, `seg${String(i).padStart(2, "0")}.mp4`);
  log(`shot ${i + 1}/${items.length} — ${s.card ?? s.clip} (${bodyLen.toFixed(1)}s)`);
  const sil = asrc(s, bodyLen, "a");
  run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", bodyFrom.toFixed(3), "-t", bodyLen.toFixed(3), "-i", s.file,
    "-filter_complex", `[0:v]${vchain(s)}[v]` + (sil ? `;${sil}` : ""),
    "-map", "[v]", "-map", sil ? "[a]" : "0:a",
    ...V, ...A, "-t", bodyLen.toFixed(3), out,
  ]);
  pieces.push(out);

  if (i === items.length - 1) break;

  // The transition: the tail of this shot against the head of the next.
  const next = items[i + 1];
  const xf = join(workDir, `xf${String(i).padStart(2, "0")}.mp4`);
  const kind = next.transition ?? "fade";
  const aFrom = s.from + s.len - X;
  const silA = asrc(s, X, "sa");
  const silB = asrc(next, X, "sb");
  run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-ss", aFrom.toFixed(3), "-t", X.toFixed(3), "-i", s.file,
    "-ss", next.from.toFixed(3), "-t", X.toFixed(3), "-i", next.file,
    "-filter_complex",
    `[0:v]${vchain(s)}[va];[1:v]${vchain(next)}[vb];` +
      `[va][vb]xfade=transition=${kind}:duration=${X}:offset=0[v];` +
      (silA ? `${silA};` : "") + (silB ? `${silB};` : "") +
      // Explicit fades and a sum, not `acrossfade`: these inputs are exactly
      // one transition long, and acrossfade wants more runway than that —
      // it failed with "Could not open encoder before EOF", which names the
      // symptom and not the cause.
      `[${silA ? "sa" : "0:a"}]afade=t=out:st=0:d=${X}[fa];` +
      `[${silB ? "sb" : "1:a"}]afade=t=in:st=0:d=${X}[fb];` +
      `[fa][fb]amix=inputs=2:normalize=0:duration=longest[aa]`,
    "-map", "[v]", "-map", "[aa]",
    ...V, ...A, "-t", X.toFixed(3), xf,
  ]);
  pieces.push(xf);
}

const listFile = join(workDir, "pieces.txt");
await writeFile(listFile, pieces.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));

const silent = join(workDir, "cut-silent.mp4");
await rm(silent, { force: true });
log(`joining ${pieces.length} pieces`);
run(ffmpegPath, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "concat", "-safe", "0", "-i", listFile,
  "-c", "copy", "-movflags", "+faststart", silent,
]);

/* ------------------------------------------------------------- the score */

const score = join(workDir, "score.wav");
if (!existsSync(score)) {
  log("synthesizing the score");
  run(process.execPath, [join(promoDir, "score.mjs"), score]);
}

const cutLen = duration(silent);
const master = join(outDir, "reel-ad.mp4");
await rm(master, { force: true });
log(`laying the score under ${cutLen.toFixed(1)}s`);
// The capture audio is already at -10 dB in the segments above; the bed sits
// at -6 dB under it. `alimiter` needs `level=disabled` or it normalises the
// limited signal straight back up to full scale.
run(ffmpegPath, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-i", silent, "-i", score,
  "-filter_complex",
  `[0:a]volume=-10dB[sfx];` +
    `[1:a]atrim=0:${cutLen.toFixed(3)},volume=-6dB,afade=t=in:st=0:d=1.2,` +
    `afade=t=out:st=${(cutLen - 4.5).toFixed(3)}:d=4.5[bed];` +
    `[sfx][bed]amix=inputs=2:normalize=0:duration=first,` +
    `alimiter=limit=0.72:level=disabled:attack=5:release=60[aout]`,
  "-map", "0:v", "-map", "[aout]",
  "-c:v", "copy", ...A, "-movflags", "+faststart", master,
]);

/* ----------------------------------------------------------- the loudness */

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
    "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.72:level=disabled:attack=5:release=60`,
    "-c:v", "copy", ...A, "-movflags", "+faststart", final,
  ]);
} else {
  run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-i", master, "-c", "copy", "-movflags", "+faststart", final]);
}
log(`done → ${final}`);
