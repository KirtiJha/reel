// Build the product tour.
//
//   node demo/build.mjs                 # everything, then assemble
//   node demo/build.mjs 04 05           # just those chapters
//   node demo/build.mjs --assemble      # re-join what is already rendered
//
// Chapters are rendered one at a time rather than as one long spec. A ten
// minute recording is ~18,000 constant-rate frames written twice as PNGs at
// full resolution, and a single flaky step at minute eight would cost the whole
// take. Rendered apart they retry cheaply, and re-cutting one line of narration
// re-renders one chapter.
//
// They join by stream copy, which only works because every chapter shares a
// viewport, scale, preset and padding — see the note at the top of chapter 0.
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, readdir, mkdir, rm, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const demoDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(demoDir, "..");
const app = resolve(repo, "..", "..", "senate-chef");
const outDir = join(demoDir, "out");
const workDir = join(demoDir, ".work");
const webDir = join(workDir, "aangan-web");

/** Aangan source the tour edits on camera, and must hand back untouched. */
const MUTATED = ["src/components/NavRail.tsx", "src/app/(tabs)/index.tsx"];

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

/**
 * Two things the terminal chapters need from the environment.
 *
 * `reel` is on PATH because filming `npm run reel --` would be filming this
 * repository's plumbing rather than the tool. `ComSpec` is Git Bash because
 * Node runs `shell: true` through it on Windows, and cmd.exe has no `ls`, no
 * `cat` and no `md5sum` — a tour of a cross-platform tool should not open on
 * three commands that only exist here.
 */
const env = { ...process.env, PATH: `${join(demoDir, "bin")};${process.env.PATH}` };
if (process.platform === "win32" && existsSync(BASH)) {
  // Windows environment variables are case-insensitive, but a plain object is
  // not: process.env spreads the key as COMSPEC, so adding `ComSpec` alongside
  // it leaves two entries and the original wins. Every casing has to go first,
  // or the terminal chapters quietly run under cmd.exe — where `reel` is an
  // extensionless shell script and does not run at all.
  for (const key of Object.keys(env)) if (/^comspec$/i.test(key)) delete env[key];
  env.ComSpec = BASH;
}

const servers = [];
const log = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);

function serve(root, port, spa) {
  const child = spawn(process.execPath, [join(demoDir, "serve.mjs"), root, String(port), ...(spa ? ["--spa"] : [])], {
    stdio: "ignore",
    env,
  });
  servers.push(child);
  return child;
}

async function up(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status > 0) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

/** Rebuild Aangan's web export — after an on-camera edit, and to undo one. */
function exportApp() {
  log("exporting the Aangan web build…");
  run("npx", ["expo", "export", "--platform", "web", "--output-dir", webDir], { cwd: app, shell: true });
}

/** Hand the app repository back exactly as we found it. */
function restoreApp() {
  const dirty = spawnSync("git", ["status", "--porcelain", ...MUTATED], { cwd: app, encoding: "utf8" }).stdout.trim();
  if (!dirty) return false;
  log(`restoring ${MUTATED.length} file(s) in the app repo`);
  run("git", ["checkout", "--", ...MUTATED], { cwd: app });
  return true;
}

const chapters = (await readdir(join(demoDir, "chapters"))).filter((f) => f.endsWith(".reel.yaml")).sort();
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const assembleOnly = process.argv.includes("--assemble");
const selected = wanted.length ? chapters.filter((c) => wanted.some((w) => c.startsWith(w))) : chapters;

try {
  await mkdir(outDir, { recursive: true });

  if (!assembleOnly) {
    if (!existsSync(webDir)) exportApp();

    serve(webDir, 4600, true);
    serve(outDir, 4599, false);
    if (!(await up("http://localhost:4600/"))) throw new Error("the Aangan build did not come up on 4600");
    if (!(await up("http://localhost:4599/"))) throw new Error("the media server did not come up on 4599");
    log("app on :4600, media on :4599");

    if (!(await up("http://localhost:4488/", 3000))) {
      warn("Studio is not running on :4488 — chapter 08 will fail. Start it with `npm run ui`.");
    }

    // Chapter 4 heals this file on camera, which is the point; the next run has
    // to start from the original.
    const specSnapshot = await readFile(join(demoDir, "example.reel.yaml"), "utf8");

    for (const chapter of selected) {
      log(`recording ${chapter}`);
      run(process.execPath, [join(repo, "dist", "cli.js"), "record", join(demoDir, "chapters", chapter)], { cwd: repo });

      // Chapters 4 and 5 edit the app and the spec in front of the camera.
      // Undo both before the next chapter films the app as it should look.
      if (/^0[45]/.test(chapter)) {
        await writeFile(join(demoDir, "example.reel.yaml"), specSnapshot);
        if (restoreApp()) exportApp();
      }
    }
  }

  // ---- assemble -------------------------------------------------------
  const parts = (await readdir(outDir))
    .filter((f) => /^\d\d-.*\.mp4$/.test(f))
    .sort();
  if (parts.length < 2) {
    warn(`only ${parts.length} chapter(s) rendered — nothing to join`);
  } else {
    const listFile = join(workDir, "chapters.txt");
    await mkdir(workDir, { recursive: true });
    await writeFile(listFile, parts.map((p) => `file '${join(outDir, p).replace(/\\/g, "/")}'`).join("\n"));

    const master = join(outDir, "reel-tour.mp4");
    await rm(master, { force: true });
    log(`joining ${parts.length} chapters`);
    run(ffmpegPath, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", master]);

    // A 16:9 master as well: the chapters are 2152×1500, which every social
    // platform would letterbox for you, less carefully.
    const wide = join(outDir, "reel-tour-1080p.mp4");
    await rm(wide, { force: true });
    log("rendering the 16:9 master");
    run(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error", "-i", master,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#070c0a",
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart", wide,
    ]);
    log(`done → ${master}`);
    log(`done → ${wide}`);
  }
} finally {
  for (const s of servers) s.kill();
  // Never leave the app repository dirty, whatever went wrong above.
  if (restoreApp()) warn("app repo restored after a failed run — its web build may be stale; re-run to rebuild");
}
