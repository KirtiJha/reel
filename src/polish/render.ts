import { mkdir, readdir, writeFile, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { cpus } from "node:os";
import type { CapturedFrame } from "../capture/frames.js";
import { ffmpeg } from "../encode/ffmpeg.js";
import { assertGifComplete } from "../encode/verify.js";
import { BITEXACT, H264, buildConcatManifest, type EncodeTargets, type EncodeOptions } from "../encode/encode.js";
import {
  resolveTimeline,
  sampleRect,
  DEFAULT_ZOOM,
  type ZoomKey,
  type ZoomConfig,
} from "./zoom.js";
import { computeFrameLayout, framingEnabled, type FrameLayout } from "./frame.js";
import {
  captionAt,
  captionFontSize,
  captionMaxTextWidth,
  captionSvg,
  type CaptionCue,
} from "./captions.js";
import type { OverlayOptions } from "sharp";
import type { Polish } from "../spec/schema.js";
import { log } from "../util/log.js";

export interface ZoomRenderInput {
  timeline: ZoomKey[];
  viewport: { width: number; height: number; scale: number };
  /** Caption timeline, composited onto the output so zoom can't clip it. */
  captions: CaptionCue[];
  /** Presentation layer: device frame, padding, background, radius. */
  polish: Polish;
  /** URL shown in the browser-frame address pill. */
  url: string;
}

/**
 * The auto-zoom render path. Sparse screencast frames can't animate a zoom over
 * a static hold, so we:
 *   1. expand the timeline to a constant-fps PNG sequence (ffmpeg),
 *   2. crop+resize each frame toward the eased zoom target (sharp, lanczos),
 *   3. encode the processed sequence to GIF/MP4/WebM.
 * Frames stay the substrate, so cursor/captions (already drawn into them) ride
 * along for free.
 */
export async function renderWithZoom(
  frames: CapturedFrame[],
  framesDir: string,
  targets: EncodeTargets,
  opts: EncodeOptions,
  zoom: ZoomRenderInput,
  beats: { label: string; t: number }[],
): Promise<void> {
  const sharp = await loadSharp();

  // 1) Constant-fps expansion from the real timeline (holds included).
  const manifestPath = join(framesDir, "frames.concat");
  await writeFile(manifestPath, buildConcatManifest(frames, opts.tailMs, opts.endMs), "utf8");
  const cfrDir = join(framesDir, "cfr");
  await mkdir(cfrDir, { recursive: true });
  await ffmpeg(
    ["-y", "-f", "concat", "-safe", "0", "-i", "frames.concat", "-vf", `fps=${opts.fps}`, "cfr/%06d.png"],
    framesDir,
  );
  const cfrFiles = (await readdir(cfrDir)).filter((f) => f.endsWith(".png")).sort();
  if (cfrFiles.length === 0) throw new Error("Constant-fps expansion produced no frames.");

  // 2) Probe the ACTUAL captured frame size — Chromium's screencast may not
  // hand back exactly viewport×scale — and derive the CSS→pixel scale from it.
  const meta = await sharp(join(cfrDir, cfrFiles[0]!)).metadata();
  const fullW = meta.width ?? zoom.viewport.width * zoom.viewport.scale;
  const fullH = meta.height ?? zoom.viewport.height * zoom.viewport.scale;
  const scaleX = fullW / zoom.viewport.width;
  const scaleY = fullH / zoom.viewport.height;

  const outW = even(opts.maxWidth ? Math.min(opts.maxWidth, fullW) : fullW);
  const outH = even(Math.round((outW * fullH) / fullW));

  const cfg: ZoomConfig = { viewport: { w: zoom.viewport.width, h: zoom.viewport.height }, ...DEFAULT_ZOOM };
  const resolved = resolveTimeline(zoom.timeline, cfg);

  // Presentation layer (device frame / padding / background). Static per run, so
  // build the decoration and corner mask once and reuse them for every frame.
  const framed = framingEnabled(zoom.polish);
  let layout: FrameLayout | null = null;
  let decorPng: Buffer | null = null;
  let maskPng: Buffer | null = null;
  if (framed) {
    layout = computeFrameLayout(zoom.polish, outW, outH, zoom.url);
    decorPng = await sharp(Buffer.from(layout.decorSvg)).png().toBuffer();
    if (layout.contentMaskSvg) maskPng = await sharp(Buffer.from(layout.contentMaskSvg)).png().toBuffer();
  }
  // The final frame (and thus the video) is the canvas when framed, else content.
  const seqW = layout ? layout.canvasW : outW;
  const seqH = layout ? layout.canvasH : outH;

  const procDir = join(framesDir, "proc");
  await mkdir(procDir, { recursive: true });

  const label = framed ? `polish (${zoom.polish.frame} frame)` : "auto-zoom";
  log.step(`Rendering ${cfrFiles.length} frames — ${label} (${seqW}×${seqH})`);
  const captions = zoom.captions ?? [];
  const captionEnd = opts.endMs ?? (cfrFiles.length / opts.fps) * 1000;
  const captionWidth = captionMaxTextWidth(outW);
  const captionSize = captionFontSize(outW);
  await mapPool(cfrFiles, Math.max(2, cpus().length - 1), async (file, i) => {
    const t = (i / opts.fps) * 1000;
    const r = sampleRect(resolved, t, cfg);
    // CSS → device px, clamped strictly inside the frame (sharp is unforgiving).
    const left = clampInt(Math.round(r.x * scaleX), 0, fullW - 2);
    const top = clampInt(Math.round(r.y * scaleY), 0, fullH - 2);
    const w = clampInt(Math.round(r.w * scaleX), 2, fullW - left);
    const h = clampInt(Math.round(r.h * scaleY), 2, fullH - top);

    const contentComposites: OverlayOptions[] = [];
    const caption = captionAt(captions, t, captionEnd, captionWidth, captionSize);
    if (caption) {
      contentComposites.push({ input: Buffer.from(captionSvg(caption, outW, outH)), top: 0, left: 0 });
    }
    // Round content corners to match the frame/radius (dest-in keeps opaque area).
    if (maskPng) contentComposites.push({ input: maskPng, blend: "dest-in" });

    const content = sharp(join(cfrDir, file))
      .extract({ left, top, width: w, height: h })
      .resize(outW, outH, { kernel: "lanczos3" });
    if (contentComposites.length) content.composite(contentComposites);

    if (layout && decorPng) {
      // Composite the content onto the prebuilt decoration (background + chrome).
      const contentBuf = await content.png().toBuffer();
      await sharp(decorPng)
        .composite([{ input: contentBuf, top: layout.contentY, left: layout.contentX }])
        .png({ compressionLevel: 3 })
        .toFile(join(procDir, file));
    } else {
      await content.png({ compressionLevel: 3 }).toFile(join(procDir, file));
    }
  });

  // 3) Encode the processed constant-fps sequence.
  const seqInput = ["-framerate", String(opts.fps), "-i", "proc/%06d.png"];

  if (targets.mp4) {
    await ensureDir(targets.mp4);
    await ffmpeg(
      [
        "-y", ...seqInput,
        "-vf", "format=yuv420p",
        ...H264, ...BITEXACT,
        abspath(targets.mp4),
      ],
      framesDir,
    );
    log.ok(`mp4  → ${targets.mp4}`);
  }

  if (targets.webm) {
    await ensureDir(targets.webm);
    await ffmpeg(
      ["-y", ...seqInput, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", ...BITEXACT, abspath(targets.webm)],
      framesDir,
    );
    log.ok(`webm → ${targets.webm}`);
  }

  if (targets.gif) {
    await ensureDir(targets.gif);
    // GIF params come from the resolved output preset (camera motion defeats
    // frame dedup, so GIFs are typically capped smaller than the video).
    // Single-pass split palette: decimate → scale → split → palettegen/use. This
    // avoids the separate-palette-image filtergraph that breaks on image
    // sequences ("Error marking filters as finished").
    const gifFps = Math.min(opts.gif.fps, opts.fps);
    const gifW = even(Math.min(opts.gif.maxWidth, seqW));
    await ffmpeg(
      [
        "-y", ...seqInput,
        "-vf",
        `fps=${gifFps},scale=${gifW}:-2:flags=lanczos,split[a][b];` +
          `[a]palettegen=stats_mode=diff:max_colors=${opts.gif.colors}[p];` +
          `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        abspath(targets.gif),
      ],
      framesDir,
    );
    // ffmpeg can finish this filtergraph early and still exit 0, leaving a GIF
    // that holds a fraction of the demo. Catch it here rather than letting a
    // truncated demo ship.
    await assertGifComplete(
      abspath(targets.gif),
      Math.round(cfrFiles.length * (gifFps / opts.fps)),
      targets.gif,
    );
    log.ok(`gif  → ${targets.gif}`);
  }

  if (targets.storyboard) {
    await mkdir(abspath(targets.storyboard), { recursive: true });
    let n = 0;
    for (const beat of beats) {
      const idx = Math.min(cfrFiles.length - 1, Math.max(0, Math.round((beat.t / 1000) * opts.fps)));
      const file = cfrFiles[idx];
      if (!file) continue;
      const safe = beat.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || `beat-${n}`;
      await copyFile(join(procDir, file), join(abspath(targets.storyboard), `${String(n++).padStart(2, "0")}-${safe}.png`));
    }
    log.ok(`storyboard → ${targets.storyboard} (${n} frames)`);
  }
}

/** Load sharp lazily so a missing native binary degrades gracefully. */
async function loadSharp(): Promise<typeof import("sharp")> {
  try {
    const mod = await import("sharp");
    return (mod.default ?? mod) as unknown as typeof import("sharp");
  } catch (err) {
    throw new Error(`Auto-zoom needs the "sharp" package: ${(err as Error).message}`);
  }
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

function even(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(lo, v), Math.max(lo, hi));
}

function abspath(p: string): string {
  return p.startsWith("/") ? p : join(process.cwd(), p);
}

async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(abspath(file)), { recursive: true });
}
