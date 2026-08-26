import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { LoadedSpec } from "../spec/load.js";
import { resolveOutput } from "../spec/load.js";
import {
  defaultPath,
  isBranch,
  resolveOutputProfile,
  type Step,
} from "../spec/schema.js";
import { applyDeterminism, DETERMINISTIC_LAUNCH_ARGS } from "./determinism.js";
import { Timeline } from "./timeline.js";
import { Recorder } from "./recorder.js";
import { TerminalController } from "../terminal/controller.js";
import { recordAlternatePaths, type BranchPoint } from "./branches.js";
import { installOverlay } from "../overlay/overlay.js";
import { ScreenshotCapture } from "../capture/screenshot.js";
import { startApp, type RunningApp } from "./app.js";
import { runStep, type StepContext, type Mode } from "./steps.js";
import { isRetryable, retryDelayMs } from "./retry.js";
import { captureFailure, reportFailure, type FailureArtifacts } from "./failure.js";
import { describeStep } from "../heal/selectors.js";
import { encode, writeStoryboard } from "../encode/encode.js";
import { resolveCutRange, sliceFrames, sliceTimeline, sliceSpans, cutDuration } from "../encode/cut.js";
import { writeInteractiveHtml, type Scene } from "../encode/html.js";
import { renderWithZoom } from "../polish/render.js";
import { framingEnabled, compositesCaptions } from "../polish/frame.js";

import { narrate } from "../narrate/index.js";
import { audioEnabled, localizeCues, missingVoiceLines, planAudio } from "../narrate/audio.js";
import { langName } from "../narrate/translate.js";
import type { SpokenCue, SpokenLine } from "../narrate/voice.js";
import { renderSfx, toWav, type SfxCue } from "../encode/sfx.js";
import { mixNarration, muxAudio } from "../encode/audio.js";
import { buildAudioRetime, buildFlowRetime, buildRetime, parseDuration } from "../polish/retime.js";
import { applyRedaction } from "../privacy/redact.js";
import { applyMocks } from "../mock/mock.js";
import type { ZoomKey } from "../polish/zoom.js";
import type { CaptionCue } from "../polish/captions.js";
import { resolveHighlights, type HighlightCue } from "../polish/highlight.js";
import { dipColor, endFades, type FadeCue } from "../polish/fade.js";
import { diagramSources, missingDiagrams } from "../media/diagram.js";
import { beatLabels, draftProfile, driveThrough, previewRange, type Preview } from "../polish/preview.js";
import { log, ReelError } from "../util/log.js";

export interface RunResult {
  frames: number;
  beats: number;
  durationMs: number;
  outputs: string[];
  /**
   * Where each beat landed on the final timeline. Kept alongside the count so
   * that later tools — `reel diff` naming the beat a change fell in — can talk
   * about the demo in its own terms rather than in raw seconds.
   */
  timeline: { label: string; t: number }[];
  /**
   * The caption timeline, for the same reason as `timeline`: `reel review` has
   * to know what the demo was claiming at the moment a frame changed, and
   * re-deriving that from the spec would mean re-running the spec.
   */
  captions: { t: number; text: string }[];
}

/**
 * A step failure, carrying what was captured at the moment it broke.
 *
 * The artifacts ride on the error rather than being logged and forgotten, so
 * every caller — the CLI, the Studio, the JSON reporter — can point at them
 * without re-deriving where they went.
 */
/** `1.4s`, for talking about a position in the demo the way a scrubber does. */
function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export class StepFailure extends ReelError {
  constructor(
    message: string,
    hint: string | undefined,
    readonly artifacts: FailureArtifacts | null,
    readonly step: { number: number; label: string },
  ) {
    super(message, hint);
    this.name = "StepFailure";
  }
}

/**
 * Full record pipeline: boot app → launch browser → apply determinism →
 * install overlay → screencast → run steps → encode. `mode: "check"` runs the
 * same steps headlessly and skips capture/encode — that's the CI drift test.
 */
export async function record(
  loaded: LoadedSpec,
  mode: Mode = "record",
  preview: Preview = {},
): Promise<RunResult> {
  const { spec } = loaded;
  let app: RunningApp | null = null;
  let browser: Browser | null = null;
  const workDir = await mkdtemp(join(tmpdir(), "reel-"));
  const framesDir = join(workDir, "frames");

  if (preview.only) {
    const known = beatLabels(spec.steps);
    if (!known.some((b) => b.toLowerCase() === preview.only!.toLowerCase())) {
      // Before the app is booted and the browser launched: naming a beat that
      // does not exist is a typo, and a typo should cost nothing.
      throw new ReelError(
        `This spec has no beat called “${preview.only}”.`,
        known.length
          ? `It has: ${known.map((b) => `“${b}”`).join(", ")}.`
          : "It has no beats or cards to preview — add a `beat:` to name a moment.",
      );
    }
  }
  const draft = Boolean(preview.draft);
  // A draft is the same demo rendered cheaply, not a different one: same steps,
  // same app, same timings. Only the resolution, the frame rate and how many
  // deliverables come out of it change.
  const profile = draft
    ? draftProfile(resolveOutputProfile(spec.output))
    : resolveOutputProfile(spec.output);
  if (draft) {
    log.info(`Draft render — ${profile.maxWidth}px at ${profile.fps}fps, video only.`);
  }

  try {
    if (spec.run) {
      // Resolve the app's working directory relative to the spec file, so specs
      // are portable regardless of where `reel` is invoked from.
      const cwd = spec.run.cwd ? resolveOutput(loaded, spec.run.cwd) : loaded.dir;
      app = await startApp({ ...spec.run, cwd });
    }

    // Headless in both modes: screencast works headless and it's what CI runs,
    // so what you record is what `reel check` verifies.
    browser = await chromium.launch({ headless: true, args: DETERMINISTIC_LAUNCH_ARGS });
    const context = await prepareContext(browser, loaded);
    const page = await context.newPage();
    // In CI drift mode, fail fast: a gone selector shouldn't cost 30s.
    if (mode === "check") page.setDefaultTimeout(8_000);

    // A virtual timeline makes the output a function of the spec rather than of
    // machine speed; see driver/timeline.ts.
    const deterministic = spec.deterministic.timeline;
    const timeline = new Timeline(spec.polish.speed);

    const capture =
      mode === "record"
        ? new ScreenshotCapture(page, framesDir, { fps: profile.fps, deterministic })
        : null;

    // Navigate to the base URL first so the overlay has a document to attach to.
    await page.goto(spec.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    if (mode === "record") {
      await installOverlay(page, {
        cursor: spec.polish.cursor !== "none",
        captions: spec.polish.captions,
        accent: spec.polish.accent,
        animate: !deterministic,
      });
      // Web fonts swap in a beat after first paint; starting capture before
      // they're ready bakes a flash of fallback text into the opening frames.
      await waitForFonts(page);
    }

    await capture?.start();
    const beats: { label: string; t: number }[] = [];
    const zoom: ZoomKey[] = [];
    const captions: CaptionCue[] = [];
    const highlights: HighlightCue[] = [];
    const fades: FadeCue[] = [];
    // Collected during the drive, spoken after it: synthesis is a post-process,
    // so a recording never waits on a TTS endpoint.
    const say: SpokenCue[] = [];
    // What the demo sounded like, for the optional effects track.
    const sfx: SfxCue[] = [];
    const scenes: Scene[] = [];
    const rec = new Recorder(page, capture, timeline, {
      fps: profile.fps,
      deterministic,
      cinematic: mode === "record",
      animationsDisabled: spec.deterministic.disableAnimations,
    });
    // The terminal is a layer in this same page, so a spec can show a command
    // and the browser it affects, and every downstream stage is unchanged.
    const term = spec.terminal
      ? new TerminalController(
          page,
          spec.terminal,
          rec,
          spec.terminal.cwd ? resolveOutput(loaded, spec.terminal.cwd) : loaded.dir,
        )
      : null;
    // Before anything is filmed, and in `check` too — a drift check that
    // recorded "command not found" as if it were the demo would be worse than
    // one that failed outright.
    term?.checkRequirements();
    if (term && mode === "record") {
      await term.install();
      await term.show("terminal"); // a terminal spec opens on the terminal
    }

    // Reassigned by the framenavigated handler below; a step that navigates
    // awaits whatever it points at before sampling another frame.
    let overlayPending: Promise<void> = Promise.resolve();

    const ctx: StepContext = {
      page,
      spec,
      mode,
      fps: profile.fps,
      now: () => timeline.now(),
      beats,
      zoom,
      captions,
      highlights,
      fades,
      say,
      sfx,
      capture,
      rec,
      term,
      scenes,
      specDir: loaded.dir,
      overlayReady: () => overlayPending,
    };
    // The opening frame: without it the timeline starts at the first thing that
    // moves, and the lead-in has to be reconstructed at encode time.
    await rec.frame();

    // Re-install overlay on every navigation (new document wipes it).
    //
    // The handler can't be async — Playwright doesn't await event listeners —
    // so the work it starts is tracked instead, and a step that navigates waits
    // for it before letting the clock advance. Otherwise the reinstall lands
    // somewhere between two sampled frames, and *which* two depends on how
    // quickly the machine got there: one extra deduped frame, on some runs and
    // not others, in a renderer whose whole promise is byte-identical output.
    if (mode === "record") {
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          overlayPending = Promise.all([
            installOverlay(page, {
              cursor: spec.polish.cursor !== "none",
              captions: spec.polish.captions,
              accent: spec.polish.accent,
              animate: !deterministic,
            }).catch(() => {}),
            // A new document wipes the terminal layer along with the overlay.
            term?.install().catch(() => {}) ?? Promise.resolve(),
          ]).then(() => {});
        }
      });
    }

    // `--only` stops the drive once the requested section has been filmed. The
    // steps after it cannot change what is inside it, and the steps before it
    // still run — the app has state, and there is no fast-forwarding an app
    // Reel knows nothing about.
    const stopAfter = mode === "record" && preview.only
      ? driveThrough(spec.steps, preview.only)
      : null;
    const total = stopAfter ?? spec.steps.length;
    log.phase(
      `Recording “${spec.name}” (${total} of ${spec.steps.length} steps)`.replace(
        `${spec.steps.length} of ${spec.steps.length} steps`,
        `${spec.steps.length} steps`,
      ),
    );
    const branchPoints: BranchPoint[] = [];
    for (let i = 0; i < total; i++) {
      const step = spec.steps[i]!;

      if (isBranch(step)) {
        // The video can only take one path; the click-through gets the rest,
        // recorded separately once the main pass is done.
        const chosen = defaultPath(step.branch);
        const id = `b${branchPoints.length + 1}`;
        branchPoints.push({ id, index: i, config: step.branch });
        log.step(`${String(i + 1).padStart(2, "0")}  branch “${step.branch.prompt}” → ${chosen.label}`);

        scenes.push({
          t: timeline.now(),
          label: step.branch.prompt,
          branch: {
            id,
            prompt: step.branch.prompt,
            paths: step.branch.paths.map((p) => ({
              id: `${id}:${pathSlug(p.label)}`,
              label: p.label,
              isDefault: p === chosen,
            })),
          },
        });

        ctx.currentPath = `${id}:${pathSlug(chosen.label)}`;
        for (const inner of chosen.steps) {
          await guarded(inner as Step, ctx, i, spec.retries, loaded, capture, framesDir);
        }
        ctx.currentPath = undefined;
        continue;
      }

      await guarded(step, ctx, i, spec.retries, loaded, capture, framesDir);
    }

    // A closing scene so the interactive build ends on the finished state.
    if (mode === "record") {
      scenes.push({ t: timeline.now(), label: "Done" });
    }

    let durationMs = timeline.now();
    const frames = (await capture?.stop(deterministic ? durationMs : undefined)) ?? [];
    // A highlight's `until:` usually names a beat that had not happened yet when
    // the step ran, so its end is only knowable now. Settled before the retimes
    // below, so the span is remapped alongside everything else.
    const resolved = resolveHighlights(highlights, beats, durationMs);
    highlights.splice(0, highlights.length, ...resolved);

    // Pacing: cap dead air and/or fit a target length. Everything downstream is
    // timestamped in demo time, so this is a remap — no re-recording.
    const retime = buildRetime(frames.map((f) => f.t), durationMs, {
      maxIdleMs: spec.polish.trimIdle,
      targetMs: parseDuration(spec.output.targetDuration),
    });
    if (retime.changed) {
      for (const f of frames) f.t = retime.map(f.t);
      for (const c of captions) c.t = retime.map(c.t);
      for (const z of zoom) z.t = retime.map(z.t);
      for (const b of beats) b.t = retime.map(b.t);
      for (const s of scenes) s.t = retime.map(s.t);
      remapHighlights(highlights, retime.map);
      remapFades(fades, retime.map);
      log.step(`Pacing ${(durationMs / 1000).toFixed(1)}s → ${(retime.endMs / 1000).toFixed(1)}s`);
      durationMs = retime.endMs;
    }

    if (mode === "check") {
      // Every branch path is a flow that can break, so drift detection has to
      // walk all of them — not just the one the video happens to take.
      if (branchPoints.length) {
        await recordAlternatePaths({
          browser,
          loaded,
          framesDir,
          points: branchPoints,
          fps: profile.fps,
          makeContext: prepareContext,
          capture: false,
        });
      }
      // Narration is drift too. A spec whose spoken lines have no audio behind
      // them renders a video that is silent where it should not be, and finding
      // that out from the finished file is finding out too late. Reported here,
      // where it costs nothing: reading the cache needs no API key.
      if (spec.audio && say.length) {
        const missing = await missingVoiceLines(say, spec.audio.voice, loaded.dir);
        if (missing.length) {
          log.warn(`${missing.length} spoken lines have no audio yet — \`reel record\` will synthesize them.`);
          for (const m of missing.slice(0, 5)) log.warn(`  “${m.slice(0, 60)}”`);
        }
      }
      // Same reasoning for diagrams: a spec whose flowchart has never been
      // drawn renders fine for its author and fails for everyone else, and the
      // cache is what makes that difference invisible until it bites.
      const diagrams = diagramSources(spec.steps, spec.theme);
      if (diagrams.length) {
        const missing = await missingDiagrams(diagrams, loaded.dir);
        if (missing.length) {
          log.warn(
            `${missing.length} diagram(s) have no rendered copy — \`reel record\` will draw them, which needs mermaid installed.`,
          );
          for (const m of missing.slice(0, 5)) log.warn(`  ${m}`);
        }
      }
      log.ok(`Drift check passed — all ${spec.steps.length} steps completed.`);
      return { frames: 0, beats: beats.length, durationMs, outputs: [], timeline: beats, captions };
    }

    // Narration.
    //
    // Deliberately after the drive and before the encode: nothing above this
    // line made a network call, so a recording is never at the mercy of a TTS
    // endpoint, and nothing here can change what the demo *did* — only how long
    // the picture waits for the voice.
    let spoken: SpokenLine[] = [];
    // Every language stretches the timeline by a different amount, because
    // translated speech is a different length. Each therefore renders from the
    // recording as it stood before *any* narration was fitted, not from the
    // master's already-stretched copy.
    const preAudio = {
      frames: frames.map((f) => ({ ...f })),
      captions: captions.map((c) => ({ ...c })),
      zoom: zoom.map((z) => ({ ...z })),
      beats: beats.map((b) => ({ ...b })),
      sfx: sfx.map((c) => ({ ...c })),
      highlights: highlights.map((h) => ({ ...h })),
      fades: fades.map((f) => ({ ...f })),
      durationMs,
    };
    if (audioEnabled(spec.audio, spec.output.audio, say)) {
      log.phase("Narration");
      const audio = spec.audio;
      if (audio.fit === "stretch" && spec.output.targetDuration !== undefined) {
        throw new ReelError(
          "`output.targetDuration` and `audio.fit: stretch` disagree about how long this demo is.",
          "Stretching to fit the narration and scaling to a fixed length cannot both win. " +
            "Set `audio.fit: none` to keep the target length, or drop `targetDuration` to let the voice decide.",
        );
      }
      // A draft speaks only what the cache already holds. Synthesis is the one
      // part of a render that costs money and needs the network, and paying it
      // to hear a line you are about to reword is the wrong trade — so a draft
      // renders the lines you have and says how many it skipped.
      let cues = say;
      if (draft) {
        const missing = new Set(await missingVoiceLines(say, audio.voice, loaded.dir));
        if (missing.size) {
          cues = say.filter((c) => !missing.has(c.text));
          log.info(`Draft: ${missing.size} line(s) not yet synthesized — rendering them silent.`);
        }
      }
      const plan = await planAudio(cues, audio.voice, loaded.dir);
      spoken = plan.lines;

      if (audio.fit === "flow") {
        // Flow inserts time only where a line would collide with the next or
        // run past the end, so the picture keeps its own pace underneath.
        const fit = buildFlowRetime(spoken, durationMs, { breathMs: audio.breathMs });
        if (fit.changed) {
          for (const f of frames) f.t = fit.map(f.t);
          for (const c of captions) c.t = fit.map(c.t);
          for (const z of zoom) z.t = fit.map(z.t);
          for (const b of beats) b.t = fit.map(b.t);
          for (const c of sfx) c.t = fit.map(c.t);
          for (const s of scenes) s.t = fit.map(s.t);
          for (const l of spoken) l.t = fit.map(l.t);
          remapHighlights(highlights, fit.map);
          remapFades(fades, fit.map);
          log.step(
            `Flowing narration ${(durationMs / 1000).toFixed(1)}s → ${(fit.endMs / 1000).toFixed(1)}s`,
          );
          durationMs = fit.endMs;
        }
      } else if (audio.fit === "stretch") {
        const fit = buildAudioRetime(frames.map((f) => f.t), spoken, durationMs, {
          breathMs: audio.breathMs,
        });
        if (fit.changed) {
          for (const f of frames) f.t = fit.map(f.t);
          for (const c of captions) c.t = fit.map(c.t);
          for (const z of zoom) z.t = fit.map(z.t);
          for (const b of beats) b.t = fit.map(b.t);
          for (const s of scenes) s.t = fit.map(s.t);
          for (const l of spoken) l.t = fit.map(l.t);
          remapHighlights(highlights, fit.map);
          remapFades(fades, fit.map);
          log.step(
            `Fitting narration ${(durationMs / 1000).toFixed(1)}s → ${(fit.endMs / 1000).toFixed(1)}s`,
          );
          durationMs = fit.endMs;
        }
      } else {
        // `fit: none` keeps the recorded timeline, so an overrun is the
        // author's to resolve — but it must be said out loud, because a line
        // that runs past its scene is not visible in the output, only audible.
        const sorted = [...spoken].sort((a, b) => a.t - b.t);
        for (const [i, line] of sorted.entries()) {
          const until = sorted[i + 1]?.t ?? durationMs;
          const over = line.t + line.durationMs - until;
          if (over > 0) {
            log.warn(
              `“${line.text.slice(0, 48)}…” runs ${(over / 1000).toFixed(1)}s past its scene.`,
            );
          }
        }
      }
    }

    // Encode deliverables.
    const outputs: string[] = [];
    // Added after every retime, because a fade-out is anchored to the end of the
    // film and the film's length is only final here.
    fades.push(
      ...endFades(
        {
          fadeIn: spec.polish.fadeIn,
          fadeOut: spec.polish.fadeOut,
          color: dipColor(spec.polish.background),
        },
        durationMs,
      ),
    );

    // A preview writes one video and nothing else. The other deliverables are
    // for publishing, and each is a full pass over the frames — a GIF palette
    // alone can cost more than the video. Written beside the real outputs
    // rather than over them, so a draft never overwrites a master you have
    // already published.
    const previewing = draft || Boolean(preview.only);
    const storyboardDir = spec.output.storyboard && !previewing
      ? resolveOutput(loaded, spec.output.storyboard)
      : undefined;
    const video = spec.output.mp4 ?? spec.output.webm ?? spec.output.gif;
    const targets = previewing
      ? {
          gif: undefined,
          mp4: video ? previewPath(resolveOutput(loaded, video)) : undefined,
          webm: undefined,
        }
      : {
          gif: spec.output.gif ? resolveOutput(loaded, spec.output.gif) : undefined,
          mp4: spec.output.mp4 ? resolveOutput(loaded, spec.output.mp4) : undefined,
          webm: spec.output.webm ? resolveOutput(loaded, spec.output.webm) : undefined,
        };
    const encodeOpts = {
      fps: profile.fps,
      maxWidth: profile.maxWidth,
      // The closing hold normally guarantees the ending is readable, but it
      // would push the result past an explicitly requested length — and a
      // target duration is usually a hard limit (a social embed's cap).
      tailMs: parseDuration(spec.output.targetDuration) ? 0 : 900,
      endMs: durationMs,
      gif: profile.gif,
    };
    // One render, used for the master and for every cut taken out of it. The
    // sharp render path handles auto-zoom AND the presentation layer (device
    // frame / padding / background); the fast concat encoder suffices when
    // neither is requested.
    const renderTo = async (
      fr: typeof frames,
      tgts: typeof targets,
      sbDir: string | undefined,
      opts: typeof encodeOpts,
      caps: typeof captions,
      zm: typeof zoom,
      bts: typeof beats,
      hls: typeof highlights,
      fds: typeof fades,
    ): Promise<void> => {
      if (compositesCaptions(spec)) {
        await renderWithZoom(
          fr,
          framesDir,
          { ...tgts, storyboard: sbDir },
          opts,
          {
            timeline: zm,
            viewport: spec.viewport,
            captions: spec.polish.captions ? caps : [],
            highlights: hls,
            fades: fds,
            polish: spec.polish,
            // Cosmetic only — what the URL pill reads. The recording still ran
            // against spec.url; this just keeps a dev server's port out of a
            // published video.
            url: spec.polish.frameUrl ?? spec.url,
          },
          bts,
        );
      } else {
        await encode(fr, framesDir, tgts, opts);
        if (sbDir) await writeStoryboard(bts, fr, framesDir, sbDir);
      }
    };

    // Skip the whole encode phase for an HTML-only build — it needs frames, not
    // a video, and the CFR expansion is the most expensive step in the pipeline.
    const needsEncode = Boolean(targets.gif || targets.mp4 || targets.webm || storyboardDir);
    if (needsEncode) log.phase("Encoding");

    if (needsEncode) {
      // `--only` renders one section of the film at full quality, which is the
      // same operation a `cut` already is: slice everything to a time range and
      // rebase it. Reusing that path rather than adding a second one means a
      // preview is composited by exactly the code that composites the master.
      const range = preview.only ? previewRange(beats, preview.only, durationMs) : null;
      if (range) {
        log.info(
          `Only “${preview.only}” — ${(range.startMs / 1000).toFixed(1)}s to ` +
            `${(range.endMs / 1000).toFixed(1)}s of ${(durationMs / 1000).toFixed(1)}s.`,
        );
        await renderTo(
          sliceFrames(frames, range),
          targets,
          undefined,
          { ...encodeOpts, endMs: cutDuration(range) },
          sliceTimeline(captions, range),
          sliceTimeline(zoom, range),
          sliceTimeline(beats, range, { carryIn: false }),
          sliceSpans(highlights, range),
          sliceSpans(fades, range),
        );
      } else {
        await renderTo(frames, targets, storyboardDir, encodeOpts, captions, zoom, beats, highlights, fades);
      }
      for (const t of [targets.gif, targets.mp4, targets.webm, storyboardDir]) if (t) outputs.push(t);
    }

    // The bed is named relative to the spec, like every other path a spec
    // carries, so a demo stays portable regardless of where reel is invoked.
    // Resolved before the cuts loop because a cut needs it too.
    const bed = spec.audio?.music;
    const music = bed
      ? {
          file: resolveOutput(loaded, bed.file),
          gain: bed.gain,
          duck: bed.duck,
          fadeInMs: bed.fadeIn,
          fadeOutMs: bed.fadeOut,
        }
      : undefined;
    if (music && !existsSync(music.file)) {
      throw new ReelError(
        `The music bed ${bed!.file} does not exist.`,
        `Looked for it at ${music.file}, relative to the spec.`,
      );
    }

    /**
     * Mix a soundtrack and put it on finished video.
     *
     * The picture is stream-copied rather than re-encoded, so what was rendered
     * and verified stays bit-for-bit what ships with audio on it. Shared by the
     * master and every cut, so the two cannot drift into different mixes.
     */
    const sfxProfile = spec.audio?.sfx ?? "none";
    const soundtrack = async (
      lines: SpokenLine[],
      totalMs: number,
      videos: (string | undefined)[],
      trackPath: string,
      cues: SfxCue[],
      label?: string,
    ): Promise<boolean> => {
      const wantsSfx = sfxProfile !== "none" && cues.length > 0;
      if (!lines.length && !music && !wantsSfx) return false;
      const carriers = videos.filter((v): v is string => Boolean(v));
      if (!carriers.length) {
        log.warn(`${label ?? "This spec"} has a soundtrack but renders no video to carry it.`);
        return false;
      }
      // Synthesized here rather than fetched or bundled, which is what keeps
      // the effects free of licensing and identical on every machine.
      let sfxFile: string | undefined;
      if (wantsSfx) {
        sfxFile = `${trackPath}.fx.wav`;
        await writeFile(sfxFile, toWav(renderSfx(cues, totalMs, sfxProfile)));
      }
      await mixNarration(
        lines.map((l) => ({ t: l.t, file: l.file, durationMs: l.durationMs })),
        trackPath,
        totalMs,
        music,
        sfxFile,
      );
      for (const v of carriers) await muxAudio(v, trackPath);
      return true;
    };

    if (spoken.length || music || (sfxProfile !== "none" && sfx.length)) {
      log.phase("Audio");
      const track = spec.output.audioTrack
        ? resolveOutput(loaded, spec.output.audioTrack)
        : join(workDir, "narration.m4a");
      if (music) {
        log.step(`Bed ${bed!.file} at ${bed!.gain}dB, ducking ${bed!.duck}dB under the voice`);
      }
      if (sfxProfile !== "none" && sfx.length) {
        log.step(`${sfx.length} sound cues (${sfxProfile})`);
      }
      // A sliced preview needs a sliced soundtrack, or the voice plays over the
      // wrong shot — the cuts path already does exactly this for the same
      // reason, so `--only` borrows it rather than muxing full-length audio
      // onto a video that is a tenth as long.
      const range = preview.only ? previewRange(beats, preview.only, durationMs) : null;
      const wrote = range
        ? await soundtrack(
            sliceTimeline(spoken, range, { carryIn: false }),
            cutDuration(range),
            [targets.mp4, targets.webm],
            track,
            sliceTimeline(sfx, range, { carryIn: false }),
          )
        : await soundtrack(spoken, durationMs, [targets.mp4, targets.webm], track, sfx);
      if (wrote && spec.output.audioTrack) outputs.push(track);
    }

    // One recording, a voice per language.
    //
    // No second drive and no second capture: the frames on disk are the same
    // frames. What differs is how long the picture waits, because a sentence
    // takes a different time to say in German than in English — so each
    // language re-fits the pre-narration snapshot to its own speech and encodes
    // from there. Captions are composited in post, which is what makes this a
    // re-encode rather than a re-record.
    const languages = previewing ? [] : spec.output.languages ?? [];
    if (languages.length && audioEnabled(spec.audio, spec.output.audio, say) && targets.mp4) {
      log.phase("Languages");
      for (const lang of languages) {
        const local = await localizeCues(say, lang);
        const parts = [
          local.authored ? `${local.authored} authored` : "",
          local.machine ? `${local.machine} machine-translated` : "",
          local.untranslated ? `${local.untranslated} left in the original` : "",
        ].filter(Boolean);
        log.step(`${langName(lang)} — ${parts.join(", ")}`);
        if (local.untranslated) {
          const n = local.untranslated;
          log.warn(
            `${n} line${n === 1 ? "" : "s"} ha${n === 1 ? "s" : "ve"} no ${lang} translation ` +
              `and will be spoken in the original.`,
          );
        }

        const plan = await planAudio(local.cues, spec.audio!.voice, loaded.dir);
        // Fresh copies: this language's stretch must not disturb the next one's.
        const lf = preAudio.frames.map((f) => ({ ...f }));
        const lc = preAudio.captions.map((c) => ({ ...c }));
        const lz = preAudio.zoom.map((z) => ({ ...z }));
        const lb = preAudio.beats.map((b) => ({ ...b }));
        const lx = preAudio.sfx.map((c) => ({ ...c }));
        const lh = preAudio.highlights.map((h) => ({ ...h }));
        const lfd = preAudio.fades.map((f) => ({ ...f }));
        let lineage = plan.lines;
        let total = preAudio.durationMs;
        if (spec.audio!.fit === "flow") {
          const fit = buildFlowRetime(lineage, total, { breathMs: spec.audio!.breathMs });
          if (fit.changed) {
            for (const f of lf) f.t = fit.map(f.t);
            for (const c of lc) c.t = fit.map(c.t);
            for (const z of lz) z.t = fit.map(z.t);
            for (const b of lb) b.t = fit.map(b.t);
            for (const c of lx) c.t = fit.map(c.t);
            lineage = lineage.map((l) => ({ ...l, t: fit.map(l.t) }));
            remapHighlights(lh, fit.map);
            remapFades(lfd, fit.map);
            total = fit.endMs;
          }
        } else if (spec.audio!.fit === "stretch") {
          const fit = buildAudioRetime(lf.map((f) => f.t), lineage, total, {
            breathMs: spec.audio!.breathMs,
          });
          if (fit.changed) {
            for (const f of lf) f.t = fit.map(f.t);
            for (const c of lc) c.t = fit.map(c.t);
            for (const z of lz) z.t = fit.map(z.t);
            for (const b of lb) b.t = fit.map(b.t);
            for (const c of lx) c.t = fit.map(c.t);
            lineage = lineage.map((l) => ({ ...l, t: fit.map(l.t) }));
            remapHighlights(lh, fit.map);
            remapFades(lfd, fit.map);
            total = fit.endMs;
          }
        }

        const base = targets.mp4.replace(/\.mp4$/i, "");
        const langMp4 = `${base}.${lang}.mp4`;
        // Only the mp4: a GIF and a storyboard carry no audio, so a language
        // variant of them would be a byte-identical duplicate of the master.
        await renderTo(
          lf,
          { gif: undefined, mp4: langMp4, webm: undefined },
          undefined,
          { ...encodeOpts, endMs: total },
          lc,
          lz,
          lb,
          lh,
          lfd,
        );
        await soundtrack(
          lineage,
          total,
          [langMp4],
          join(workDir, `narration.${lang}.m4a`),
          lx,
          `The ${langName(lang)} track`,
        );
        outputs.push(langMp4);
        log.ok(`${langName(lang)} → ${langMp4} (${(total / 1000).toFixed(1)}s)`);
      }
    }

    // Cuts: shorter deliverables out of the recording that just happened. No
    // browser, no second pass over the app — the frames are already on disk,
    // which is what makes a cut incapable of disagreeing with the master.
    if (spec.cuts?.length && !previewing) {
      log.phase("Cuts");
      for (const cut of spec.cuts) {
        const range = resolveCutRange(cut, beats, durationMs);
        const cutFrames = sliceFrames(frames, range);
        if (cutFrames.length === 0) {
          throw new ReelError(
            `Cut "${cut.name}" covers ${formatMs(range.startMs)}–${formatMs(range.endMs)}, ` +
              `which caught no frames.`,
            "Check its `from` and `to` against the beats this demo actually records.",
          );
        }
        const cutProfile = resolveOutputProfile(cut.output);
        const cutSb = cut.output.storyboard ? resolveOutput(loaded, cut.output.storyboard) : undefined;
        const cutTargets = {
          gif: cut.output.gif ? resolveOutput(loaded, cut.output.gif) : undefined,
          mp4: cut.output.mp4 ? resolveOutput(loaded, cut.output.mp4) : undefined,
          webm: cut.output.webm ? resolveOutput(loaded, cut.output.webm) : undefined,
        };
        await renderTo(
          cutFrames,
          cutTargets,
          cutSb,
          {
            ...encodeOpts,
            fps: cutProfile.fps,
            maxWidth: cutProfile.maxWidth,
            gif: cutProfile.gif,
            endMs: cutDuration(range),
          },
          // Captions and zooms carry in: whatever was on screen when the cut
          // opens is still on screen. Beats do not — a chapter that ended
          // before the cut began would mislabel it.
          sliceTimeline(captions, range),
          sliceTimeline(zoom, range),
          sliceTimeline(beats, range, { carryIn: false }),
          // A span, not a point: an annotation straddling the in point is on
          // screen when the cut opens even though no `t` of its own is inside.
          sliceSpans(highlights, range),
          sliceSpans(fades, range),
        );
        // The cut's own soundtrack, from the same lines and the same bed.
        //
        // `carryIn: false` because narration is not like a caption: a caption
        // that was already on screen when the cut opens is still true, but a
        // sentence that started earlier arrives halfway through a word. A line
        // belongs to a cut only if it begins inside it.
        const cutLines = sliceTimeline(spoken, range, { carryIn: false });
        await soundtrack(
          cutLines,
          cutDuration(range),
          [cutTargets.mp4, cutTargets.webm],
          join(workDir, `cut-${outputs.length}.m4a`),
          // Effects are placed, not spoken, so unlike narration a cue that
          // began before the cut has nothing to be halfway through — it either
          // lands inside the window or it does not.
          sliceTimeline(sfx, range, { carryIn: false }),
          `Cut "${cut.name}"`,
        );

        log.step(
          `${cut.name} — ${formatMs(range.startMs)}–${formatMs(range.endMs)} ` +
            `(${(cutDuration(range) / 1000).toFixed(1)}s)` +
            (cutLines.length ? ` · ${cutLines.length} spoken` : ""),
        );
        for (const t of [cutTargets.gif, cutTargets.mp4, cutTargets.webm, cutSb]) {
          if (t) outputs.push(t);
        }
      }
    }

    // Interactive build: the same demo as a self-contained click-through, and
    // the only output that can carry more than one path.
    if (spec.output.html && !previewing) {
      const htmlPath = resolveOutput(loaded, spec.output.html);
      log.phase("Interactive");
      let allScenes = scenes;
      if (branchPoints.length) {
        const alt = await recordAlternatePaths({
          browser,
          loaded,
          framesDir,
          points: branchPoints,
          fps: profile.fps,
          makeContext: prepareContext,
        });
        allScenes = [...scenes, ...alt.scenes];
      }
      await writeInteractiveHtml({
        scenes: allScenes,
        frames,
        framesDir,
        outPath: htmlPath,
        spec,
        maxWidth: profile.maxWidth,
        durationMs,
      });
      outputs.push(htmlPath);
    }

    // Narration: subtitles and localized variants (all opt-in).
    const out = spec.output;
    if (out.subtitles || out.languages?.length) {
      let subtitleBase: string | undefined;
      if (out.subtitles === true) {
        const src = targets.mp4 ?? targets.webm ?? targets.gif;
        subtitleBase = src ? src.replace(/\.[^.]+$/, "") : undefined;
      } else if (typeof out.subtitles === "string") {
        subtitleBase = resolveOutput(loaded, out.subtitles).replace(/\.(srt|vtt)$/i, "");
      }
      log.phase("Narration");
      const narrated = await narrate({
        captions,
        endMs: durationMs,
        mp4: targets.mp4,
        webm: targets.webm,
        subtitleBase,
        languages: out.languages,
        workDir,
      });
      outputs.push(...narrated);
    }

    return { frames: frames.length, beats: beats.length, durationMs, outputs, timeline: beats, captions };
  } finally {
    await browser?.close().catch(() => {});
    await app?.stop().catch(() => {});
    // REEL_KEEP_FRAMES leaves the intermediate frames on disk. Encoder problems
    // are otherwise near-impossible to reproduce: the inputs that triggered them
    // are deleted by the time the failure is read.
    if (process.env.REEL_KEEP_FRAMES) log.warn(`Keeping frames: ${workDir}`);
    else await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run a step and, if it fails for good, capture the scene of the crime before
 * the browser closes. The window is narrow: `finally` tears down the context a
 * few lines later, and by the time the error surfaces the page is gone.
 */
async function guarded(
  step: Step,
  ctx: StepContext,
  i: number,
  retries: number,
  loaded: LoadedSpec,
  capture: ScreenshotCapture | null,
  framesDir: string,
): Promise<void> {
  try {
    await runStepWithRetries(step, ctx, i, retries);
  } catch (err) {
    const error = err as Error;
    const label = describeStep(step);
    const artifacts = await captureFailure(ctx.page, {
      stepNumber: i + 1,
      label,
      step,
      error,
      specPath: loaded.path,
      frames: capture?.captured(),
      framesDir,
    });
    reportFailure(artifacts);
    throw new StepFailure(error.message, undefined, artifacts, { number: i + 1, label });
  }
}

/** Stable id fragment for a branch path label. */
/**
 * Move an annotation span onto a retimed clock.
 *
 * Both ends, because a span that only moved its start would grow or shrink
 * every time the timeline was remapped — and a demo can be remapped three times
 * over (idle trim, then narration fitting, then again per language).
 */
function remapHighlights(highlights: HighlightCue[], map: (t: number) => number): void {
  for (const h of highlights) {
    h.from = map(h.from);
    h.to = map(h.to);
  }
}

/** A fade is a span too, and both ends move with the clock. */
function remapFades(fades: FadeCue[], map: (t: number) => number): void {
  for (const f of fades) {
    f.from = map(f.from);
    f.to = map(f.to);
  }
}

/**
 * Where a preview is written: `demo.mp4` becomes `demo.preview.mp4`.
 *
 * Never over the master. A draft is a small, low-fps, partly-silent render, and
 * overwriting a published file with one — then having the next `--if-changed`
 * decide everything is up to date — is a footgun with a very quiet trigger.
 */
function previewPath(output: string): string {
  return output.replace(/(\.[^.]+)$/, ".preview$1");
}

function pathSlug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "path";
}

/**
 * Run a step, retrying transient failures when repeating it is provably safe
 * (see driver/retry.ts). A demo that fails once in twenty on a slow runner is
 * a broken build signal, not a broken demo.
 */
async function runStepWithRetries(
  step: Step,
  ctx: StepContext,
  i: number,
  retries: number,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runStep(step, ctx, i);
      return;
    } catch (err) {
      if (attempt >= retries || !isRetryable(step, err)) throw err;
      const delay = retryDelayMs(attempt);
      log.warn(
        `Step ${i + 1} failed (${(err as Error).message.split("\n")[0]}) — retry ${attempt + 1}/${retries} in ${delay}ms`,
      );
      await ctx.page.waitForTimeout(delay);
    }
  }
}

/**
 * Wait for web fonts to finish loading (bounded, so a font that never resolves
 * can't hang a recording). Without this the first frames can catch fallback
 * text mid-swap — a subtle but very visible "cheap recording" tell.
 */
async function waitForFonts(page: Page): Promise<void> {
  await Promise.race([
    page.evaluate(() => (document as any).fonts?.ready).catch(() => {}),
    page.waitForTimeout(3_000),
  ]);
}

/**
 * A browser context with every reproducibility control already installed.
 *
 * Alternate branch paths are recorded in their own context, and they have to be
 * prepared exactly like the main pass — same frozen clock, same mocks, same
 * redaction — or the paths a viewer switches between wouldn't agree with each
 * other. Getting this subtly wrong is easy, so there is one way to build one.
 */
export async function prepareContext(
  browser: Browser,
  loaded: LoadedSpec,
): Promise<BrowserContext> {
  const { spec } = loaded;
  const context = await createContext(browser, loaded);
  await applyDeterminism(context, spec.deterministic);
  if (spec.mock) await applyMocks(context, spec.mock, loaded);
  if (spec.redact) await applyRedaction(context, spec.redact);
  return context;
}

async function createContext(browser: Browser, loaded: LoadedSpec): Promise<BrowserContext> {
  const { spec } = loaded;
  return browser.newContext({
    viewport: { width: spec.viewport.width, height: spec.viewport.height },
    deviceScaleFactor: spec.viewport.scale,
    colorScheme: spec.theme,
    reducedMotion: spec.deterministic.reducedMotion ? "reduce" : "no-preference",
    // Pin locale/timezone alongside the frozen clock — otherwise a CI runner in
    // another region renders different dates than the machine that recorded.
    locale: spec.deterministic.locale,
    timezoneId: spec.deterministic.timezone,
    storageState: spec.storageState ? resolveOutput(loaded, spec.storageState) : undefined,
  });
}

/** Convenience wrapper for `reel check`. */
export async function check(loaded: LoadedSpec): Promise<void> {
  try {
    await record(loaded, "check");
  } catch (err) {
    // A StepFailure already carries the artifacts and the step it broke on;
    // re-wrapping it would lose both.
    if (err instanceof StepFailure) {
      throw new StepFailure(
        `Drift check FAILED at step ${err.step.number} (${err.step.label}): ${err.message}`,
        "A step could not complete — your demo no longer matches the app.",
        err.artifacts,
        err.step,
      );
    }
    if (err instanceof ReelError) throw err;
    throw new ReelError(
      `Drift check FAILED: ${(err as Error).message}`,
      "A step could not complete — your demo no longer matches the app.",
    );
  }
}
