import { mkdir, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import type { CapturedFrame } from "../capture/frames.js";
import { ffmpeg, type FfmpegProgress } from "../encode/ffmpeg.js";
import { assertGifComplete } from "../encode/verify.js";
import {
  BITEXACT,
  H264,
  buildConcatManifest,
  ensureOutDir,
  outPath,
  type EncodeTargets,
  type EncodeOptions,
} from "../encode/encode.js";
import {
  resolveTimeline,
  sampleRect,
  DEFAULT_ZOOM,
  type ZoomKey,
  type Rect,
  type ZoomConfig,
  withIdleMotion,
} from "./zoom.js";
import { computeFrameLayout, framingEnabled, type FrameLayout } from "./frame.js";
import { highlightsAt, highlightSvg, type HighlightCue } from "./highlight.js";
import { fadeAt, fadeSvg, type FadeCue } from "./fade.js";
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
import { progress } from "../util/progress.js";

export interface ZoomRenderInput {
  timeline: ZoomKey[];
  viewport: { width: number; height: number; scale: number };
  /**
   * Where the app's content sits, so a wide shot frames the app rather than the
   * page it is centred on. Absent — or when the app already fills its viewport
   * — the camera behaves exactly as it did.
   */
  content?: Rect;
  /** Caption timeline, composited onto the output so zoom can't clip it. */
  captions: CaptionCue[];
  /** Annotation spans, drawn in content space so the camera carries them. */
  highlights?: HighlightCue[];
  /** Dips to a colour, over the whole canvas rather than the app view. */
  fades?: FadeCue[];
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
  // Cleared, not just created. These are working directories keyed on the
  // frames dir, and the frame numbering restarts at 000001 every time — so a
  // second render into the same place (a cut taken out of the master, say)
  // reads back its own frames *and* the previous render's, and silently
  // produces a video longer than the recording it came from.
  await rm(cfrDir, { recursive: true, force: true });
  await mkdir(cfrDir, { recursive: true });
  // The recording's own length, which is what every pass below is measured
  // against: the expansion walks it once, and the encodes each walk it again.
  const timelineMs = opts.endMs ?? (frames[frames.length - 1]?.t ?? 0) + opts.tailMs;
  await withProgress("Expanding", timelineMs, (p) =>
    ffmpeg(
      ["-y", "-f", "concat", "-safe", "0", "-i", "frames.concat", "-vf", `fps=${opts.fps}`, "cfr/%06d.png"],
      framesDir,
      p,
    ),
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

  const cfg: ZoomConfig = {
    viewport: { w: zoom.viewport.width, h: zoom.viewport.height },
    ...DEFAULT_ZOOM,
    ...(zoom.content ? { content: zoom.content } : {}),
  };
  // Drift through stretches where nothing changes. Applied to the resolved
  // rects rather than the keyframes, because what should drift is the shot the
  // camera actually settled on, not the element box it was derived from.
  // `auto` follows the camera, so `zoom: false` — usually a terminal demo,
  // where pushing in would blur the text — stays still. An explicit `drift`
  // overrides that, which is how a terminal chapter narrated over a settled
  // screen gets some life without turning auto-zoom back on.
  const drifting =
    zoom.polish.idleMotion === "drift" ||
    (zoom.polish.idleMotion === "auto" && zoom.polish.zoom === "auto");
  const resolved =
    drifting
      ? withIdleMotion(
          resolveTimeline(zoom.timeline, cfg),
          frames.map((f) => f.t),
          opts.endMs ?? frames[frames.length - 1]?.t ?? 0,
          { afterMs: zoom.polish.idleMotionAfter, scale: zoom.polish.idleMotionScale },
        )
      : resolveTimeline(zoom.timeline, cfg);

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
  // Cleared for the same reason as cfr above.
  await rm(procDir, { recursive: true, force: true });
  await mkdir(procDir, { recursive: true });

  const label = framed ? `polish (${zoom.polish.frame} frame)` : "auto-zoom";
  log.step(`Rendering ${cfrFiles.length} frames — ${label} (${seqW}×${seqH})`);
  // ~190ms a frame: a ten-minute demo is twenty minutes in this loop alone.
  // Without a count coming out of it there is no way to tell a render that is
  // slow from one that has hung, which is the difference between waiting and
  // reaching for Ctrl-C.
  const framePass = progress("Rendering", cfrFiles.length);
  const captions = zoom.captions ?? [];
  const marks = zoom.highlights ?? [];
  const fades = zoom.fades ?? [];
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
    // Annotations are mapped through `r`, the crop being shown at this instant,
    // so they sit *in* the picture: they track the zoom, drift with idle motion
    // and leave frame when the camera moves off them. A caption deliberately
    // does none of that, which is why the two are laid out separately.
    if (marks.length) {
      const svg = highlightSvg(highlightsAt(marks, t), r, outW, outH, zoom.polish.accent);
      if (svg) contentComposites.push({ input: Buffer.from(svg), top: 0, left: 0 });
    }
    // Round content corners to match the frame/radius (dest-in keeps opaque area).
    if (maskPng) contentComposites.push({ input: maskPng, blend: "dest-in" });

    // A fade is the film going dark, so it goes over the finished canvas —
    // device frame, padding and background included. Washing only the content
    // would read as the app dimming inside a window that stayed lit. With no
    // frame there is no canvas but the content, so it joins that list instead:
    // sharp's `composite` replaces rather than appends, and a second call here
    // would silently drop the captions and annotations already queued.
    const fade = fades.length ? fadeAt(fades, t) : null;
    if (fade && !layout) {
      contentComposites.push({ input: Buffer.from(fadeSvg(fade, outW, outH)), top: 0, left: 0 });
    }

    const content = sharp(join(cfrDir, file))
      .extract({ left, top, width: w, height: h })
      .resize(outW, outH, { kernel: "lanczos3" });
    if (contentComposites.length) content.composite(contentComposites);

    if (layout && decorPng) {
      // Composite the content onto the prebuilt decoration (background + chrome).
      const contentBuf = await content.png().toBuffer();
      const canvas = sharp(decorPng).composite([
        { input: contentBuf, top: layout.contentY, left: layout.contentX },
        ...(fade
          ? [{ input: Buffer.from(fadeSvg(fade, layout.canvasW, layout.canvasH)), top: 0, left: 0 }]
          : []),
      ]);
      await canvas.png({ compressionLevel: 3 }).toFile(join(procDir, file));
    } else {
      await content.png({ compressionLevel: 3 }).toFile(join(procDir, file));
    }
    framePass.tick();
  });
  framePass.done();

  // 3) Encode the processed constant-fps sequence.
  const seqInput = ["-framerate", String(opts.fps), "-i", "proc/%06d.png"];
  const seqMs = (cfrFiles.length / opts.fps) * 1000;

  if (targets.mp4) {
    await ensureOutDir(targets.mp4);
    await withProgress("mp4", seqMs, (p) =>
      ffmpeg(
        [
          "-y", ...seqInput,
          "-vf", "format=yuv420p",
          ...H264, ...BITEXACT,
          outPath(targets.mp4!),
        ],
        framesDir,
        p,
      ),
    );
    log.ok(`mp4  → ${targets.mp4}`);
  }

  if (targets.webm) {
    await ensureOutDir(targets.webm);
    await withProgress("webm", seqMs, (p) =>
      ffmpeg(
        ["-y", ...seqInput, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", ...BITEXACT, outPath(targets.webm!)],
        framesDir,
        p,
      ),
    );
    log.ok(`webm → ${targets.webm}`);
  }

  if (targets.gif) {
    await ensureOutDir(targets.gif);
    // GIF params come from the resolved output preset (camera motion defeats
    // frame dedup, so GIFs are typically capped smaller than the video).
    const gifFps = Math.min(opts.gif.fps, opts.fps);
    const gifW = even(Math.min(opts.gif.maxWidth, seqW));

    // The palette filtergraph is fed from a video, not from the PNG sequence.
    //
    // palettegen/paletteuse and the image2 demuxer do not cooperate: on some
    // sequences ffmpeg exits 0 having written a single frame, and the same graph
    // reading a video file produces the full animation. It is silent and
    // input-dependent — the identical command that worked for one demo emitted
    // one frame for the next, which is what makes it worth the extra pass rather
    // than a documented caveat.
    //
    // ffv1 because the intermediate must be lossless (a GIF quantises to a few
    // hundred colours; feeding it h264 artifacts wastes palette entries) and
    // deterministic, which BITEXACT keeps. It lives in the temp frames dir and
    // goes away with it.
    const mid = "gif-source.mkv";
    await withProgress("gif (lossless pass)", seqMs, (p) =>
      ffmpeg(["-y", ...seqInput, "-c:v", "ffv1", "-level", "3", ...BITEXACT, mid], framesDir, p),
    );
    await withProgress("gif", seqMs, (p) =>
      ffmpeg(
        [
          "-y", "-i", mid,
          "-vf",
          `fps=${gifFps},scale=${gifW}:-2:flags=lanczos,split[a][b];` +
            `[a]palettegen=stats_mode=diff:max_colors=${opts.gif.colors}[p];` +
            `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
          outPath(targets.gif!),
        ],
        framesDir,
        p,
      ),
    );
    // ffmpeg can finish this filtergraph early and still exit 0, leaving a GIF
    // that holds a fraction of the demo. Catch it here rather than letting a
    // truncated demo ship.
    await assertGifComplete(
      outPath(targets.gif),
      Math.round(cfrFiles.length * (gifFps / opts.fps)),
      targets.gif,
    );
    log.ok(`gif  → ${targets.gif}`);
  }

  if (targets.webp) {
    await ensureOutDir(targets.webp);
    const w = opts.webp ?? { fps: opts.gif.fps, maxWidth: opts.gif.maxWidth, quality: 80 };
    // Same rate and width as the GIF, so the two deliverables are the same cut.
    const webpFps = Math.min(w.fps, opts.fps);
    const webpW = even(Math.min(w.maxWidth, seqW));
    // Straight from the PNG sequence: the lossless intermediate above exists
    // only because palettegen and the image2 demuxer disagree, and WebP has no
    // palette to generate.
    await withProgress("webp", seqMs, (p) =>
      ffmpeg(
        [
          "-y", ...seqInput,
          "-vf", `fps=${webpFps},scale=${webpW}:-2:flags=lanczos`,
          // Forever, matching what a GIF does in a README. Without it libwebp
          // writes a single-play animation, and a demo that stops dead on its
          // last frame reads as a broken image rather than as a choice.
          "-loop", "0",
          "-c:v", "libwebp_anim",
          "-lossless", "0",
          "-q:v", String(w.quality),
          // Slowest search: this runs once and the file is then served for
          // years, so the trade is not close.
          "-compression_level", "6",
          ...BITEXACT,
          outPath(targets.webp!),
        ],
        framesDir,
        p,
      ),
    );
    log.ok(`webp → ${targets.webp}`);
  }

  if (targets.storyboard) {
    await mkdir(outPath(targets.storyboard), { recursive: true });
    let n = 0;
    for (const [b, beat] of beats.entries()) {
      const idx = storyboardFrame(beats, b, opts.fps, cfg.transitionMs, cfrFiles.length);
      const file = cfrFiles[idx];
      if (!file) continue;
      const safe = beat.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || `beat-${n}`;
      await copyFile(join(procDir, file), join(outPath(targets.storyboard), `${String(n++).padStart(2, "0")}-${safe}.png`));
    }
    log.ok(`storyboard → ${targets.storyboard} (${n} frames)`);
  }
}

/**
 * Which rendered frame stands for a beat in the storyboard.
 *
 * A beat marks where the camera *starts* moving, not where it arrives. Sampled
 * at that instant the still catches the shot mid-glide — a wide `hero` beat came
 * out as the tight crop the camera was in the act of leaving, which is the one
 * frame that misrepresents the demo it exists to summarise.
 *
 * So it waits out the camera move, but never past the beat's own span: a still
 * that showed the shot after it would be a different kind of wrong.
 */
export function storyboardFrame(
  beats: { t: number }[],
  index: number,
  fps: number,
  settleMs: number,
  frameCount: number,
): number {
  const beat = beats[index]!;
  const next = beats[index + 1]?.t ?? Infinity;
  // Stop one frame short of the next beat, so the still belongs to this one.
  const latest = next - 1000 / fps;
  const at = Math.max(beat.t, Math.min(beat.t + settleMs, latest));
  return Math.min(frameCount - 1, Math.max(0, Math.round((at / 1000) * fps)));
}

/**
 * Run one ffmpeg pass under a progress reporter.
 *
 * ffmpeg reports where it is on the output timeline rather than how many frames
 * it has left, so the estimate is derived from position against the recording's
 * known length — which is the same number the author sees in the summary line.
 */
async function withProgress(
  label: string,
  totalMs: number,
  run: (p: FfmpegProgress | undefined) => Promise<void>,
): Promise<void> {
  if (!(totalMs > 0)) return run(undefined);
  const p = progress(label, totalMs, { kind: "ms" });
  try {
    await run({ totalMs, onProgress: (positionMs) => p.at(positionMs) });
  } finally {
    p.done();
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

