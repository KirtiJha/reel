// Build the promo.
//
//   node promo/build.mjs              # everything, then assemble
//   node promo/build.mjs 03 05        # re-record just those chapters
//   node promo/build.mjs --assemble   # re-join what is already rendered
//   node promo/build.mjs --no-prereq  # skip the renders the film films
//
// Chapters are rendered one at a time rather than as one long spec, for the
// reason demo/build.mjs gives: a four-minute take is thousands of constant-rate
// frames, and one flaky step at minute three should not cost the whole film.
//
// Unlike the product tour, this one does NOT join by stream copy. It
// cross-dissolves, which means a re-encode — the film is a promo rather than a
// verified artifact, and a dissolve between chapters is most of what separates
// "some clips" from something somebody will watch to the end.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const promoDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(promoDir, "..");
const outDir = join(promoDir, "out");
const workDir = join(promoDir, ".work");
const siteDir = join(outDir, "site");

/** Length of every cross-dissolve, in seconds. */
const XFADE = 0.6;

/**
 * `reel` on PATH, so the terminal chapters type what an installed user types.
 *
 * Filming `npm run dev -- check` would be filming this repository's plumbing
 * rather than the tool. Same trick demo/build.mjs uses, pointed at the tsx
 * entry point so the promo needs no build step first.
 */
const env = { ...process.env, PATH: `${join(promoDir, "bin")}:${process.env.PATH}` };

const log = (m) => console.log(`\x1b[36m›\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, cwd: repo, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

/** ffprobe is not bundled; ffmpeg itself will tell us a file's duration. */
function duration(file) {
  const r = spawnSync(ffmpegPath, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(r.stderr ?? "");
  if (!m) throw new Error(`could not read a duration from ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const servers = [];
function serve(root, port) {
  const p = spawn(process.execPath, [join(repo, "demo", "serve.mjs"), root, String(port)], {
    stdio: "ignore",
    env,
  });
  servers.push(p);
}

async function up(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const reel = (...args) => run(process.execPath, [join(repo, "node_modules", ".bin", "tsx"), join(repo, "src", "cli.ts"), ...args]);

/**
 * The things the film films.
 *
 * Chapter 4 drives an interactive build and chapter 7 drives a published site;
 * both have to exist on disk first, and both are ordinary Reel output rather
 * than fixtures made for the camera. That is the point — but it does mean the
 * promo cannot be built from a clean checkout without this step.
 */
async function prereqs() {
  const branching = join(repo, "examples", "taskflow", "out", "branching.html");
  if (!existsSync(branching)) {
    log("rendering the interactive build chapter 4 drives");
    reel("record", join(repo, "examples", "taskflow", "branching.reel.yaml"));
  }
  const taskflowGif = join(repo, "examples", "taskflow", "out", "taskflow.gif");
  if (!existsSync(taskflowGif)) {
    log("rendering a second demo, so the gallery and the site are not one card");
    reel("record", join(repo, "examples", "taskflow", "demo.reel.yaml"));
  }
  if (!existsSync(join(promoDir, "out", "mini.gif"))) {
    log("rendering mini.reel.yaml — the spec chapter 2 puts on screen");
    reel("record", join(promoDir, "mini.reel.yaml"));
  }

  log("publishing the site chapter 7 drives");
  await rm(siteDir, { recursive: true, force: true });
  reel("publish", siteDir, "--specs", "examples/taskflow/*.reel.yaml", "--specs", "promo/mini.reel.yaml", "--title", "TaskFlow demos");
}

/* ------------------------------------------------------------------ build */

const chapters = (await readdir(promoDir)).filter((f) => /^\d\d-.*\.reel\.yaml$/.test(f)).sort();
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const assembleOnly = process.argv.includes("--assemble");
const skipPrereq = process.argv.includes("--no-prereq");
const selected = wanted.length ? chapters.filter((c) => wanted.some((w) => c.startsWith(w))) : chapters;

try {
  await mkdir(outDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  if (!assembleOnly) {
    if (!skipPrereq) await prereqs();

    serve(join(repo, "examples", "taskflow", "out"), 4597);
    serve(siteDir, 4596);
    if (!(await up("http://localhost:4597/branching.html"))) throw new Error("the interactive build did not come up on 4597");
    if (!(await up("http://localhost:4596/"))) throw new Error("the published site did not come up on 4596");
    log("interactive build on :4597, published site on :4596");

    if (!(await up("http://localhost:4488/", 6))) {
      throw new Error("Studio is not running on :4488 — chapters 3 and 6 need it. Start it with `npm run ui`.");
    }

    for (const chapter of selected) {
      log(`recording ${chapter}`);
      reel("record", join(promoDir, chapter));
    }
  }

  /* --------------------------------------------------------------- score */

  const score = join(workDir, "score.wav");
  if (!existsSync(score)) {
    log("synthesizing the score");
    run(process.execPath, [join(promoDir, "score.mjs"), score]);
  }

  /* ------------------------------------------------------------ assemble */

  const parts = (await readdir(outDir)).filter((f) => /^\d\d-.*\.mp4$/.test(f)).sort().map((f) => join(outDir, f));
  if (parts.length < 2) {
    warn(`only ${parts.length} chapter(s) rendered — nothing to join`);
    process.exit(0);
  }

  const durations = parts.map(duration);
  const total = durations.reduce((a, b) => a + b, 0) - XFADE * (parts.length - 1);
  log(`${parts.length} chapters, ${total.toFixed(1)}s after ${parts.length - 1} dissolves`);

  // Where each chapter starts on the finished timeline. Every dissolve eats
  // XFADE seconds, so chapter i begins that much earlier than its raw offset —
  // and the audio has to be delayed by exactly the same amount or the clicks
  // drift away from the clicking.
  const starts = [];
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    starts.push(at);
    at += durations[i] - XFADE;
  }

  // Most joins are a plain dissolve. The one into the chapter where the build
  // goes red dips through black instead, because that beat wants a breath.
  const kindFor = (i) => (parts[i + 1].includes("05-ci") ? "fadeblack" : "fade");

  const filter = [];
  parts.forEach((_, i) => {
    filter.push(`[${i}:v]scale=1920:1080:flags=lanczos,format=yuv420p,setsar=1,fps=30[v${i}]`);
  });
  let vPrev = "v0";
  for (let i = 1; i < parts.length; i++) {
    const label = i === parts.length - 1 ? "vout" : `vx${i}`;
    // `offset` is where the dissolve begins on the stream built so far, which
    // is the next chapter's start — not a running sum of raw durations.
    filter.push(
      `[${vPrev}][v${i}]xfade=transition=${kindFor(i - 1)}:duration=${XFADE}:offset=${starts[i].toFixed(3)}[${label}]`,
    );
    vPrev = label;
  }

  // Audio: every chapter's sound effects pushed to its own start, the score
  // laid underneath, all summed. `amix` would duck each input by the number of
  // inputs; `amerge`/sum via `amix:normalize=0` keeps the levels as authored.
  parts.forEach((_, i) => {
    filter.push(`[${i}:a]adelay=${Math.round(starts[i] * 1000)}|${Math.round(starts[i] * 1000)},volume=3dB[a${i}]`);
  });
  filter.push(`[${parts.length}:a]atrim=0:${total.toFixed(3)},volume=-13dB,afade=t=out:st=${(total - 4).toFixed(3)}:d=4[score]`);
  filter.push(
    `${parts.map((_, i) => `[a${i}]`).join("")}[score]amix=inputs=${parts.length + 1}:normalize=0:duration=longest[aout]`,
  );

  const master = join(outDir, "reel-promo.mp4");
  await rm(master, { force: true });
  const filterFile = join(workDir, "filter.txt");
  await writeFile(filterFile, filter.join(";\n"));

  log("assembling");
  run(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error", "-stats",
    ...parts.flatMap((p) => ["-i", p]),
    "-i", score,
    "-filter_complex_script", filterFile,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    "-t", total.toFixed(3),
    master,
  ]);

  // One gain stage at the end rather than loudnorm's dynamic mode: this is a
  // sparse mix of clicks over a bed, and a compressor chasing -14 LUFS would
  // pump the bed up every time nothing was clicking.
  log("measuring loudness");
  const measured = spawnSync(ffmpegPath, ["-hide_banner", "-nostats", "-i", master, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const lufs = Number(/I:\s+(-?\d+\.\d+) LUFS/.exec(measured.stderr ?? "")?.[1]);
  if (Number.isFinite(lufs)) {
    const gain = (-14 - lufs).toFixed(2);
    log(`mix is ${lufs} LUFS — applying ${gain} dB for YouTube's -14`);
    const levelled = join(outDir, "reel-promo-final.mp4");
    await rm(levelled, { force: true });
    run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", master,
      "-af", `volume=${gain}dB,alimiter=limit=0.89`,
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      levelled,
    ]);
    log(`done → ${levelled}`);
  } else {
    warn("could not measure loudness — leaving the mix as it is");
    log(`done → ${master}`);
  }
} finally {
  for (const s of servers) s.kill();
}
