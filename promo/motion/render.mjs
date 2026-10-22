// Motion graphics for the promo, rendered frame by frame.
//
// ## Why this exists
//
// The first cut of this film was made entirely out of Reel's own output, which
// means every frame of it was a browser window on a gradient. That is the right
// material for the proof — the captures are the argument — but it is not an
// advertisement. Nothing moved except the app being driven, the title cards
// were small centred text, and nine chapters of identical composition read as
// documentation.
//
// So: a second layer. Full-screen typography that animates, built the same way
// Reel builds everything — a real page in a real browser, captured frame by
// frame — and cut between the captures rather than over them.
//
// ## How the timing works
//
// The page exposes `window.setT(seconds)` and every animated property is a
// pure function of that number. Nothing uses CSS animation or
// requestAnimationFrame, for the reason Reel freezes the clock: a renderer that
// samples a real-time animation gets a different film every run, and one that
// samples a function gets the same film forever.
//
//   node promo/motion/render.mjs <card> <out.mp4> [--seconds N]

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { card, CARDS } from "./cards.mjs";

const FPS = 30;
const W = 1920;
const H = 1080;

export async function renderCard(name, outFile, seconds) {
  const spec = CARDS[name];
  if (!spec) throw new Error(`no card named ${name} — have ${Object.keys(CARDS).join(", ")}`);
  const dur = seconds ?? spec.seconds;
  const frames = Math.round(dur * FPS);

  const dir = await mkdtemp(join(tmpdir(), "reel-motion-"));
  const browser = await chromium.launch({
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const html = card(name);
    await writeFile(join(dir, "card.html"), html, "utf8");
    await page.goto(`file://${join(dir, "card.html")}`);
    await page.waitForFunction("typeof window.setT === 'function'");
    // Fonts have to be in before the first frame or frame 0 renders in a
    // fallback face and the whole opener flickers on the cut.
    await page.evaluate(() => document.fonts.ready);

    for (let f = 0; f < frames; f++) {
      await page.evaluate((t) => window.setT(t), f / FPS);
      await page.screenshot({
        path: join(dir, `f${String(f).padStart(5, "0")}.png`),
        animations: "disabled",
      });
    }

    execFileSync(ffmpegPath, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", String(FPS),
      "-i", join(dir, "f%05d.png"),
      "-c:v", "libx264", "-preset", "slow", "-crf", "16",
      "-pix_fmt", "yuv420p", "-r", String(FPS),
      outFile,
    ]);
    return { frames, seconds: dur, out: outFile };
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, out] = process.argv.slice(2);
  const sIdx = process.argv.indexOf("--seconds");
  const secs = sIdx > -1 ? Number(process.argv[sIdx + 1]) : undefined;
  if (!name || !out) {
    console.error("usage: node promo/motion/render.mjs <card> <out.mp4> [--seconds N]");
    console.error(`cards: ${Object.keys(CARDS).join(", ")}`);
    process.exit(2);
  }
  const r = await renderCard(name, out, secs);
  console.log(`${name} → ${r.out} (${r.frames} frames, ${r.seconds}s)`);
}
