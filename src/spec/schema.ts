import { z } from "zod";
import { DEFAULT_THEME, THEME_NAMES, TERMINAL_THEMES } from "../terminal/themes.js";

/**
 * The Reel demo spec — the heart of the tool.
 *
 * Design principles (see product plan §7):
 *  - Waits are on STATES, not time.
 *  - Captions and zoom are first-class.
 *  - A `beat` marks hero frames (longer holds).
 *  - The file is small and diffs cleanly.
 *
 * The schema is versioned so the format can evolve under semver.
 */

export const SPEC_VERSION = 1;

const cssColor = z.string().min(1);

/** The browser window the demo is filmed in. */
export const viewportSchema = z.object({
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(800),
  /** device pixel ratio — 2 = retina. */
  scale: z.number().positive().max(4).default(2),
});
export type Viewport = z.infer<typeof viewportSchema>;

/**
 * Determinism controls. Real web apps are non-deterministic (animations,
 * Date.now(), live data). VHS never had to care because a terminal is fully
 * controlled — a browser is not. These make `reel check` stable and keep
 * drift-detection from crying wolf.
 */
export const deterministicSchema = z.object({
  /** Freeze Date/performance.now to a fixed instant. ISO string or epoch ms. */
  freezeClock: z.union([z.string(), z.number()]).optional(),
  /** Disable CSS animations/transitions and the text caret blink. */
  disableAnimations: z.boolean().default(true),
  /** Seed Math.random for reproducible app behaviour. */
  seedRandom: z.number().optional(),
  /** Force prefers-reduced-motion at the app level. */
  reducedMotion: z.boolean().default(false),
  /**
   * Pin the browser locale (e.g. "en-US"). Without this, a CI runner with a
   * different system locale formats dates/numbers differently than your laptop
   * — a frozen clock alone doesn't make text reproducible.
   */
  locale: z.string().optional(),
  /** Pin the browser timezone (e.g. "UTC", "America/New_York"). */
  timezone: z.string().optional(),
  /**
   * Drive the recording off a virtual clock instead of wall-clock time, so the
   * same spec against the same app renders byte-identical media on any machine.
   * Without it, output length swings with CPU load and CI rewrites the media on
   * every push whether or not the demo changed.
   *
   * Turn it off only to film an app's own animation as it really happens.
   */
  timeline: z.boolean().default(true),
});
export type Deterministic = z.infer<typeof deterministicSchema>;

/**
 * How the demo is filmed and presented: camera, cursor, captions, and the
 * frame around the page. None of it changes what the app does.
 */
export const polishSchema = z.object({
  /** auto = zoom toward the active element; false = never zoom. */
  zoom: z.union([z.literal("auto"), z.literal(false)]).default("auto"),
  /**
   * In a terminal demo, let the camera follow each command's output — the same
   * region `zoom: { to: output }` names, applied after every command.
   *
   * Opt-in rather than implied by `zoom: auto`, which every spec gets by
   * default: turning it on for everyone would re-shoot existing terminal demos
   * on upgrade, and `reel check` compares rendered output, so that lands as a
   * CI failure rather than a nicer demo. `zoom: false` still switches off
   * everything.
   */
  zoomOutput: z.boolean().default(false),
  /**
   * Most rows the camera frames at once in a terminal demo. Longer output is
   * framed at its tail, where the newest lines are.
   */
  zoomRows: z.number().int().positive().max(120).default(12),
  /** Render a synthetic cursor that eases between targets. */
  cursor: z.union([z.literal("smooth"), z.literal("none")]).default("smooth"),
  /** Show caption text overlays. */
  captions: z.boolean().default(true),
  /**
   * Device frame around the captured page:
   *  - none    : no chrome
   *  - browser : macOS-style window with traffic lights + a URL pill
   *  - window  : macOS-style window with traffic lights only
   */
  frame: z.enum(["none", "browser", "window"]).default("none"),
  /**
   * Address shown in the browser frame's URL pill.
   *
   * Demos are filmed against whatever serves the app locally, so without this
   * every published video has `localhost:4500` in the chrome — which tells the
   * viewer they are watching a developer's laptop rather than the product. Set
   * it to the address people actually type.
   *
   * It is cosmetic by design: it changes the pixels in the pill and nothing
   * else. The demo still runs against `url`, so this cannot be used to make a
   * recording claim it visited somewhere it did not.
   */
  frameUrl: z.string().optional(),
  /**
   * Outer padding around the frame, in reference px (at 1000px-wide output;
   * scales with resolution). When a frame is set, a sensible default is used.
   */
  padding: z.number().int().nonnegative().default(0),
  /** Background behind the padded frame — a CSS color or gradient. */
  background: z.string().default("#0b0b0f"),
  /** Rounded-corner radius (reference px) applied to the captured page. */
  radius: z.number().int().nonnegative().default(0),
  /**
   * Brand accent — used by the click ripple, the callout spotlight ring, and
   * the title-card rule. One knob so a repo's demos look like one product.
   */
  accent: cssColor.default("#6d8bff"),
  /**
   * Playback rate for every authored duration — holds, captions, typing, camera
   * moves. 2 renders the same demo in half the time; 0.5 slows it down. Real
   * waiting (selectors, network) is unaffected: this paces the demo, it doesn't
   * rush the app.
   */
  speed: z.number().positive().max(10).default(1),
  /**
   * Cap any stretch where nothing on screen changes at this many ms.
   *
   * Blunt on purpose, and worth understanding before reaching for it: it can't
   * tell dead air from a deliberate pause, so a 1700ms title card under
   * `trimIdle: 700` becomes 700ms — too fast to read. On a virtual timeline
   * real waiting already costs no demo time, so what's left to trim is mostly
   * what you authored. Use it to rescue a demo full of long waits, not to
   * tighten one that is already paced. To shorten a paced demo, prefer
   * `speed` or `output.targetDuration`, which scale everything proportionally.
   */
  trimIdle: z.number().int().positive().optional(),
  /**
   * Drift the camera where nothing on screen is changing.
   *
   * The capture emits a frame only when something moves, so a stretch narrated
   * over a settled screen is one still image held for however long the voice
   * takes. A slow push-in costs nothing — the frames are already on disk and
   * the camera is already interpolated — and it is the difference between a
   * demo and a slideshow.
   *
   * `auto` follows the camera: drift where `zoom: auto`, hold still where
   * `zoom: false`. That default matters because `zoom: false` is usually a
   * terminal demo, where pushing in would blur the text the demo exists to
   * show — and overriding that would be answering a question the author
   * already answered.
   *
   * `drift` asks for it regardless, which is the way to add life to a terminal
   * chapter that would otherwise sit still under a long line of narration.
   */
  idleMotion: z.enum(["auto", "drift", "none"]).default("auto"),
  /** How long nothing may change before the camera starts to drift. */
  idleMotionAfter: z.number().int().positive().default(1800),
  /**
   * How far the drift pushes in, as a fraction of the shot. 0.94 is a 6% move
   * across the whole silence — noticeable as life, not as a zoom.
   */
  idleMotionScale: z.number().min(0.8).max(1).default(0.94),
});
export type Polish = z.infer<typeof polishSchema>;

/**
 * The voice that reads the narration.
 *
 * The API key is never written here. Specs are committed, often to public
 * repositories, which is the same reason there is deliberately no `${ENV}`
 * interpolation anywhere in this grammar — the key comes from the environment.
 */
export const voiceSchema = z.object({
  provider: z.enum(["openai", "elevenlabs"]).default("openai"),
  /** Voice id or name, as the vendor names it. Omit for the provider default. */
  id: z.string().optional(),
  /** The synthesis model. Omit for the provider default. */
  model: z.string().optional(),
  /**
   * Free-text direction — "calm, confident technical explainer, unhurried".
   * Honoured where the vendor supports steering, and ignored with a warning
   * where it doesn't, rather than silently changing nothing.
   */
  style: z.string().optional(),
  /** Playback rate asked of the vendor. Past about 1.15 it starts to sound rushed. */
  speed: z.number().min(0.5).max(2).default(1),
});
export type Voice = z.infer<typeof voiceSchema>;

/**
 * Spoken narration.
 *
 * Captions are written to be read — terse, telegraphic. Spoken aloud that same
 * text comes out clipped, because there is no connective tissue to carry
 * rhythm. So narration is its own text (`say:` on a caption or card), and this
 * block only says how it is voiced and how the timeline accommodates it.
 *
 * Audio is a post-process: the driver records exactly as it does without it and
 * makes no network calls. Nothing here can change what the demo does.
 */
export const audioSchema = z.object({
  voice: voiceSchema.default({}),
  /**
   * What happens when a spoken line runs longer than the hold it was written
   * for — which it usually will, since `ms` was chosen for reading.
   *
   * `flow` is the default and what a product tour wants: the demo runs at the
   * pace it was authored, a line plays over whatever happens next, and time is
   * inserted only where a line would collide with the next or run past the end.
   *
   * `stretch` grows the hold a line sits on until the sentence finishes. It
   * never cuts narration off and never lets the picture move either — a long
   * line freezes the frame for as long as it takes to say. Right for a title
   * card being read aloud; wrong for anything with something to show.
   *
   * `none` leaves the timeline exactly as recorded and warns about every line
   * that overruns, for demos whose narration was written against known holds.
   *
   * (A fourth mode — keep the authored length and read faster to fit — is not
   * here yet. It needs re-synthesis at a computed rate, and a half-working
   * version that silently rushed the delivery would be worse than its absence.)
   */
  fit: z.enum(["flow", "stretch", "none"]).default("flow"),
  /** Silence between consecutive spoken lines, so delivery has room to breathe. */
  breathMs: z.number().int().nonnegative().default(350),
  /**
   * UI sound design: a tick on a click, key texture while typing, a low sweep
   * under a title card.
   *
   * Synthesized, not sampled — there is nothing to license and nothing shipped.
   * Off by default: it is a taste, and a demo that started making noises
   * because narration was switched on would be a surprise rather than a
   * feature.
   */
  sfx: z.enum(["none", "subtle", "full"]).default("none"),
  /**
   * A music bed under the whole demo.
   *
   * Reel ships no tracks. Licensing makes bundling them a liability, and a
   * bundled bed would be instantly recognisable across everyone's demos — point
   * `file` at something you have the right to use.
   */
  music: z
    .object({
      /** Path to the audio file, relative to the spec. Looped to fit. */
      file: z.string().min(1),
      /** Level before ducking, in dB. Beds belong well under the voice. */
      gain: z.number().max(0).default(-22),
      /**
       * How far the bed drops while someone is speaking, in dB.
       *
       * Honoured exactly: the envelope is built from the narration timings
       * rather than from a compressor listening to the voice, so this number
       * means what it says.
       */
      duck: z.number().max(0).default(-12),
      // Spelled out rather than sharing the `durationMs` helper: that const is
      // declared with the step grammar far below this point, and a module-scope
      // const used above its declaration is a runtime error, not a type error.
      fadeIn: z.number().int().nonnegative().default(1200),
      fadeOut: z.number().int().nonnegative().default(2500),
    })
    .optional(),
});
export type AudioConfig = z.infer<typeof audioSchema>;

/**
 * App lifecycle — how the app under test gets started. The plan implied a
 * running `url` but never said how it boots; real demos need this.
 */
export const runSchema = z.object({
  /** Shell command to boot the app (e.g. "npm run dev"). */
  cmd: z.string(),
  /** Working directory for the command. */
  cwd: z.string().optional(),
  /** URL/port to poll until the app is ready before recording. */
  readyOn: z.string().optional(),
  /** Max ms to wait for readiness. */
  timeout: z.number().int().positive().default(60_000),
  /** Extra env vars for the spawned process. */
  env: z.record(z.string()).optional(),
});
export type RunConfig = z.infer<typeof runSchema>;

/**
 * Delivery presets. A demo isn't only a README GIF — it might be a crisp video
 * for social, a high-fidelity clip, or lightweight docs media. The preset picks
 * sensible defaults for resolution, frame rate, and GIF compression; any field
 * can still be overridden explicitly.
 */
export const PRESETS = {
  /** Balanced default — good quality, reasonable size, shares anywhere. */
  share: { fps: 30, maxWidth: 1200, gif: { fps: 20, maxWidth: 800, colors: 160 } },
  /** Lightweight GIF tuned to stay small in a README. */
  readme: { fps: 24, maxWidth: 1000, gif: { fps: 16, maxWidth: 640, colors: 96 } },
  /** Maximum fidelity — highest resolution/frame rate, rich GIF palette. */
  hq: { fps: 30, maxWidth: 1920, gif: { fps: 24, maxWidth: 1000, colors: 240 } },
  /** Crisp, video-first for social embeds. */
  social: { fps: 30, maxWidth: 1280, gif: { fps: 20, maxWidth: 960, colors: 200 } },
  /** Clean docs media — moderate everything. */
  docs: { fps: 30, maxWidth: 1100, gif: { fps: 18, maxWidth: 760, colors: 128 } },
} as const;

export type PresetName = keyof typeof PRESETS;

/** What gets rendered, and where it is written. */
export const outputSchema = z
  .object({
    /** Delivery profile; sets defaults for the fields below. */
    preset: z.enum(["share", "readme", "hq", "social", "docs"]).default("share"),
    gif: z.string().optional(),
    mp4: z.string().optional(),
    webm: z.string().optional(),
    /** Directory to drop a PNG storyboard (one image per beat). */
    storyboard: z.string().optional(),
    /**
     * Self-contained interactive HTML: a click-through of the same demo, with
     * hotspots on the elements you acted on. One file, no hosting.
     */
    html: z.string().optional(),
    /** Frame rate for video (overrides preset). */
    fps: z.number().int().positive().max(60).optional(),
    /** Cap the output width in px (overrides preset). */
    maxWidth: z.number().int().positive().optional(),
    /** GIF-specific overrides (GIFs trade size for smoothness/palette). */
    gifFps: z.number().int().positive().max(50).optional(),
    gifMaxWidth: z.number().int().positive().optional(),
    gifColors: z.number().int().min(16).max(256).optional(),
    /** Emit sidecar subtitles from the captions. true, or an explicit path base. */
    subtitles: z.union([z.boolean(), z.string()]).optional(),
    /**
     * Mux the narration into the video. Needs an `audio:` block and at least one
     * `say:` line; without either it is a no-op, not an error, so a spec can
     * carry the flag before it carries the script.
     */
    audio: z.boolean().optional(),
    /** Also write the bare mixed track here, for editing elsewhere. */
    audioTrack: z.string().optional(),
    /** Localize the subtitles into these languages, e.g. ["es","fr"]. */
    languages: z.array(z.string()).optional(),
    /**
     * Fit the finished demo to a length: `30`, `"30s"`, `"1500ms"`. Applied
     * after `polish.trimIdle`, by rescaling the recorded timeline rather than
     * re-running the demo. Useful where length is a hard limit (social embeds).
     */
    targetDuration: z.union([z.number().positive(), z.string()]).optional(),
  })
  .refine((o) => o.gif || o.mp4 || o.webm || o.storyboard || o.html, {
    message: "output must specify at least one of: gif, mp4, webm, storyboard, html",
  });
export type Output = z.infer<typeof outputSchema>;

/** A fully-resolved output profile — preset defaults with overrides applied. */
export interface OutputProfile {
  fps: number;
  maxWidth: number;
  gif: { fps: number; maxWidth: number; colors: number };
}

export function resolveOutputProfile(o: Output): OutputProfile {
  const base = PRESETS[o.preset];
  return {
    fps: o.fps ?? base.fps,
    maxWidth: o.maxWidth ?? base.maxWidth,
    gif: {
      fps: o.gifFps ?? base.gif.fps,
      maxWidth: o.gifMaxWidth ?? base.gif.maxWidth,
      colors: o.gifColors ?? base.gif.colors,
    },
  };
}

/* ------------------------------ Cuts ------------------------------ */

/**
 * A shorter deliverable taken out of the same recording.
 *
 * `from` and `to` are beat labels or millisecond offsets, and labels are the
 * point: `from: pricing` still means the right moment after the demo above it
 * gets a slower caption, where `from: 42000` quietly starts pointing into the
 * middle of a sentence. Omit either end to run from the start, or to the end.
 *
 * Each cut carries its own `output`, so the same range can be a high-fidelity
 * MP4 in one cut and a small GIF in another.
 */
export const cutSchema = z.object({
  /** What this cut is for — `youtube`, `readme`. Used in logs and errors. */
  name: z.string().min(1),
  /** Beat label or ms offset to start from. Omit to start at the beginning. */
  from: z.union([z.string(), z.number().nonnegative()]).optional(),
  /** Beat label or ms offset to end at. Omit to run to the end. */
  to: z.union([z.string(), z.number().nonnegative()]).optional(),
  output: outputSchema,
});

export type Cut = z.infer<typeof cutSchema>;

/* ---------------------------- Terminal ---------------------------- */

/**
 * Terminal demos. The terminal renders as a layer in the same page as the app,
 * so one spec can show a command and the browser it affects, and every existing
 * feature — zoom, captions, cards, device frames, encoding, the interactive
 * build — works on it unchanged.
 */
export const terminalSchema = z
  .object({
    cols: z.number().int().positive().max(300).default(90),
    rows: z.number().int().positive().max(120).default(24),
    /** Working directory for commands; relative to the spec file. */
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /** The prompt drawn before each typed command. */
    prompt: z.string().default("$ "),
    title: z.string().default("zsh — reel"),
    /**
     * Named colour scheme. Supplies the 16 ANSI colours plus a matching
     * background and foreground; set either of those explicitly to override it.
     */
    theme: z.enum(THEME_NAMES).default(DEFAULT_THEME),
    background: cssColor.optional(),
    foreground: cssColor.optional(),
    /** Replace the theme's 16 ANSI colours outright: 8 normal, then 8 bright. */
    palette: z.array(cssColor).length(16).optional(),
    fontSize: z.number().int().positive().default(15),
    fontFamily: z.string().optional(),
    /**
     * Programs the demo needs on PATH.
     *
     * Checked once before anything runs, so a missing dependency fails with the
     * name of what's absent rather than partway through with whatever error the
     * shell happened to produce.
     */
    require: z.array(z.string().min(1)).default([]),
    /** Per-character delay while the command is typed on camera (ms). */
    typing: z.number().int().nonnegative().default(55),
    /** Longest a single command may take before it's killed (ms). */
    timeout: z.number().int().positive().default(120_000),
    /**
     * Longest the captured output may take to stream back on camera (ms).
     * Output is replayed, not filmed live, so a slow command still reads fast.
     */
    replayMs: z.number().int().nonnegative().default(2200),
  })
  // Resolve the theme here so everything downstream receives concrete colours
  // and never has to know that named schemes exist.
  .transform((cfg) => {
    const theme = TERMINAL_THEMES[cfg.theme];
    return {
      ...cfg,
      background: cfg.background ?? theme.background,
      foreground: cfg.foreground ?? theme.foreground,
      palette: (cfg.palette ?? theme.palette) as readonly string[],
    };
  });
export type TerminalConfig = z.infer<typeof terminalSchema>;

/* ----------------------------- Steps ----------------------------- */

const selector = z.string().min(1);
const durationMs = z.number().int().nonnegative();
/** Narration for one step: what to say, or `false` to keep it silent. */
const sayText = z.union([z.string().min(1), z.literal(false)]);
/**
 * The same line in other languages, keyed by code — `{ es: "…", ja: "…" }`.
 *
 * Written by a person, because this is the copy a customer hears. Machine
 * translation fills the gaps when a model is configured, but a demo is
 * marketing, and marketing copy nobody has read is not something to ship by
 * default.
 */
const sayIn = z.record(z.string().min(1));

/**
 * Steps are expressed as single-key objects so YAML stays terse and readable:
 *   - goto: /
 *   - click: text=Get started
 *   - type: { selector: "#email", text: "you@acme.com" }
 *
 * Every action step auto-waits (Playwright semantics) and, where it makes
 * sense, records a `beat` so the encoder holds on meaningful frames.
 */
const baseStepSchema = z.union([
  /** Navigate. A path is resolved against `url`; a full URL is used as given. */
  z.object({ goto: z.string() }).strict(),
  /**
   * Become signed in, mid-demo, without filming the sign-in.
   *
   * `storageState` authenticates a whole run, which is the right answer when
   * the demo starts inside the product. It is the wrong answer when the demo
   * opens on a marketing page, a logged-out home screen or a paywall — the
   * story needs to begin signed *out* and cross over.
   *
   * This applies a session saved by `reel capture --save-auth` to the running
   * browser and reloads, so one continuous demo can show the logged-out page,
   * cover the transition with a card, and carry on inside the product. No
   * jump cut between two renders, one camera path, one caption timeline.
   *
   * Deliberately a saved session rather than a scripted login: filming a real
   * sign-in means a password in the spec, and there is no way to put one there
   * for exactly that reason.
   */
  z
    .object({
      signIn: z.union([
        z.string(),
        z.object({
          /** Path to a Playwright storage state, relative to the spec. */
          state: z.string(),
          /** Where to land afterwards. Omit to reload wherever the demo is. */
          goto: z.string().optional(),
        }),
      ]),
    })
    .strict(),
  /** Click an element. The cursor glides to it first, and the click ripples. */
  z.object({ click: selector }).strict(),
  /** Double-click an element. */
  z.object({ dblclick: selector }).strict(),
  /**
   * Drag one element onto another — a card between columns, a node onto a
   * canvas, a handle along a slider.
   *
   * The gesture a click grammar cannot express, and the reason kanban boards,
   * flow builders and range inputs could not be filmed at all. `to` is another
   * element, or a point when the destination is empty canvas with nothing to
   * name.
   */
  z
    .object({
      drag: z.object({
        from: selector,
        /** The element to drop onto, or a viewport point. */
        to: z.union([selector, z.object({ x: z.number(), y: z.number() })]),
        /** How long the travel takes on camera. */
        ms: durationMs.default(900),
      }),
    })
    .strict(),
  /** Move the cursor onto an element without clicking — for menus and tooltips. */
  z.object({ hover: selector }).strict(),
  /** Type into a field, character by character, so the typing reads on camera. */
  z
    .object({
      type: z.object({
        selector,
        text: z.string(),
        /** Per-character delay (ms) so typing reads naturally on camera. */
        delay: durationMs.default(60),
      }),
    })
    .strict(),
  /** Press a key (`Enter`, `Escape`, `Control+K`). Targets an element, or the page. */
  z.object({ press: z.object({ selector: selector.optional(), key: z.string() }) }).strict(),
  /** Set a field's value in one go. Use `type` when the typing is the point. */
  z.object({ fill: z.object({ selector, text: z.string() }) }).strict(),
  /** Scroll an element into view. Use `scroll` for a filmed, cinematic pan. */
  z.object({ scrollTo: selector }).strict(),
  /** State-based wait — the reliability moat. Never a raw sleep by default. */
  /**
   * State-based wait — the reliability moat. Never a raw sleep by default.
   *
   * The object form exists for the rare wait that is legitimately long: a build
   * running inside the page, a job whose progress the UI streams. The default
   * is deliberately short so that a *broken* selector fails fast instead of
   * stalling the recording, and raising it globally would trade that away for
   * every step. Naming the one step that needs longer keeps the rest honest.
   */
  z.object({
    waitFor: z.union([selector, z.object({ selector, timeout: z.number().int().positive() })]),
  }).strict(),
  /** Wait until the address bar matches — a substring, or a glob with `*`. */
  z.object({ waitForUrl: z.string() }).strict(),
  /** Wait for in-flight requests to settle. A last resort — prefer `waitFor`. */
  z.object({ waitForNetworkIdle: z.boolean().default(true) }).strict(),
  /**
   * Caption overlay. A bare string shows until the next caption; the object
   * form can set an explicit duration and screen position.
   */
  z.object({
    caption: z.union([
      z.string(),
      z.object({
        text: z.string(),
        /** How long to hold this caption (ms). Omit to run until the next one. */
        ms: durationMs.optional(),
        position: z.enum(["bottom", "top"]).default("bottom"),
        /**
         * What the narrator says here, written for the ear rather than the eye.
         * Omit and the caption's own text is spoken; `false` keeps this caption
         * silent, which is right for a label that reads better than it speaks.
         */
        say: sayText.optional(),
        /** The same line in other languages, for `output.languages`. */
        sayIn: sayIn.optional(),
      }),
    ]),
  }).strict(),
  /**
   * Narration with nothing on screen — a line that carries the demo between two
   * things the viewer can see. Holds like a caption does, and draws nothing.
   */
  z.object({
    say: z.union([
      z.string(),
      z.object({
        text: z.string(),
        /** Hold at least this long. The spoken line extends it when it needs to. */
        ms: durationMs.optional(),
        /** The same line in other languages, for `output.languages`. */
        sayIn: sayIn.optional(),
      }),
    ]),
  }).strict(),
  /** Hero frame: hold longer here. Optional label for the storyboard. */
  z.object({ beat: z.union([z.string(), z.boolean()]) }).strict(),
  /**
   * A full-screen title card — the scene grammar a continuous screen recording
   * lacks. Use it to open, to separate chapters, and to close.
   */
  z.object({
    card: z.union([
      z.string(),
      z.object({
        title: z.string(),
        subtitle: z.string().optional(),
        ms: durationMs.default(1800),
        /**
         * What the narrator says over the card. Unlike a caption there is no
         * sensible fallback — a title read aloud sounds like a title — so a
         * card is silent unless this says otherwise.
         */
        say: sayText.optional(),
        /** The same line in other languages, for `output.languages`. */
        sayIn: sayIn.optional(),
      }),
    ]),
  }).strict(),
  /**
   * Spotlight an element: everything else dims, an accent ring draws around it,
   * and an optional label explains it. The camera eases toward it too.
   */
  z.object({
    callout: z.object({
      selector,
      text: z.string().optional(),
      ms: durationMs.default(1500),
    }),
  }).strict(),
  /**
   * Mark an element without interrupting: the rest of the screen is untouched,
   * the camera does not move, and the demo keeps running underneath.
   *
   * The counterpart to `callout`, not a replacement for it. A callout says
   * *stop and look at this* — it dims the page and holds the film. A highlight
   * says *and notice this, as we go*, which is what a demo narrated over a
   * working app needs. Use both; they are different sentences.
   *
   * Several may be on screen at once, and one can outlive the step that drew it
   * — see `until`.
   */
  z.object({
    highlight: z.object({
      selector,
      /** `box` frames it, `circle` rings it, `underline` sits beneath it. */
      shape: z.enum(["box", "circle", "underline"]).default("box"),
      /** `drawn` looks sketched by hand; `clean` is a precise stroke. */
      style: z.enum(["drawn", "clean"]).default("drawn"),
      /** A few words beside the mark. Long text wants a `callout` instead. */
      label: z.string().optional(),
      /** How long it stays up. Ignored when `until` names a beat. */
      ms: durationMs.default(2600),
      /**
       * Keep it up until this beat, however many steps away that is — the
       * reason a highlight is a span and not a hold. A beat that never happens
       * leaves the mark up until the demo ends.
       */
      until: z.string().min(1).optional(),
    }),
  }).strict(),
  /** Cinematic eased scroll — to an element, or to an absolute Y offset. */
  z.object({
    scroll: z.object({
      to: z.union([selector, z.number()]),
      ms: durationMs.default(900),
    }),
  }).strict(),
  /**
   * Explicit camera control, for when auto-zoom's choice isn't the story you're
   * telling. "out" is a wide establishing shot.
   */
  z.object({
    zoom: z.union([
      z.literal("out"),
      z.object({
        /**
         * A selector, or — in a terminal demo — `output` for the rows the last
         * command wrote, `cursor` for the live prompt line, or `text=…` to
         * frame whatever rows contain that text.
         */
        to: z.union([z.literal("output"), z.literal("cursor"), selector]).optional(),
        /** Magnification: 1 = whole viewport, 2 = half of it, … */
        level: z.number().min(1).max(4).optional(),
        /** Camera move duration (ms). */
        ms: durationMs.optional(),
      }),
    ]),
  }).strict(),
  /**
   * An assertion. Unlike `waitFor` (which only proves an element appears), this
   * checks what the app actually rendered — so `reel check` is a real smoke
   * test, not just a selector-existence probe.
   */
  z.object({
    expect: z.object({
      selector,
      /** The element's text must contain this. */
      text: z.string().optional(),
      /** Exactly this many elements must match. */
      count: z.number().int().nonnegative().optional(),
      /** Whether the element must be visible (default true). */
      visible: z.boolean().default(true),
    }),
  }).strict(),
  /** Explicit pause — discouraged, but sometimes you want a deliberate hold. */
  z.object({ hold: durationMs }).strict(),

  /* --- Terminal steps (require a `terminal:` block) --- */

  /**
   * Type a command at the prompt, run it, and replay its output. The command
   * really runs — so like `expect`, this makes `reel check` a genuine smoke
   * test of the CLI, not a scripted illusion of one.
   */
  z.object({
    run: z.union([
      z.string(),
      z.object({
        cmd: z.string(),
        /** Text piped to stdin, for commands that prompt. */
        input: z.string().optional(),
        /** Fail the run unless the command exits with this code. */
        expectCode: z.number().int().optional(),
        /** Override the replay budget for this command (ms). */
        replayMs: durationMs.optional(),
        /**
         * Run the command off camera.
         *
         * For the setup a demo needs but nobody wants to watch — seeding a
         * fixture, creating a scratch directory, installing something. The
         * command still runs and `expectCode` still applies, so it stays part of
         * what `reel check` verifies; it simply never reaches the screen.
         *
         * Note that each command runs in its own shell, so `cd` in a hidden step
         * does not carry into later ones. Set `terminal.cwd` for that.
         */
        hidden: z.boolean().default(false),
      }),
    ]),
  }).strict(),
  /** Assert the terminal screen contains this text. */
  z.object({ expectOutput: z.string() }).strict(),
  /** Clear the terminal screen. */
  z.object({ clear: z.boolean() }).strict(),
  /** Switch between the terminal and the app underneath it. */
  z.object({ show: z.enum(["terminal", "app"]) }).strict(),
]);
/** Every step except `branch` — what a branch path may contain. */
export type BaseStep = z.infer<typeof baseStepSchema>;

/**
 * A fork the viewer chooses between.
 *
 * Two constraints shape this. A video is linear, so the rendered GIF/MP4
 * follows one designated path while the interactive build carries the whole
 * tree. And the app has state, so alternate paths can't be spliced in after the
 * fact — Reel re-runs the steps leading up to the branch before recording each
 * one, which is the only approach that holds for an app it knows nothing about.
 */
export const branchPathSchema = z.object({
  label: z.string().min(1),
  /**
   * The path the video follows, and the one pre-selected in the click-through.
   * Defaults to the first path when none is marked.
   */
  default: z.boolean().default(false),
  steps: z.array(baseStepSchema).min(1),
});
export type BranchPath = z.infer<typeof branchPathSchema>;

export const branchSchema = z.object({
  /** The question put to the viewer, e.g. "What do you want to see?" */
  prompt: z.string().default("Choose a path"),
  paths: z.array(branchPathSchema).min(2),
});
export type BranchConfig = z.infer<typeof branchSchema>;

/** One action in the demo. Every step is a single-key object. */
export const stepSchema = z.union([
  baseStepSchema,
  /** A fork the viewer chooses between, in the interactive build. */
  z.object({ branch: branchSchema }).strict(),
]);
export type Step = z.infer<typeof stepSchema>;
/**
 * A step as a person writes it, before defaults are filled in.
 *
 * What `reel capture` and `reel author` produce: they emit YAML, so requiring
 * the defaulted shape would mean inventing values for keys the draft has every
 * reason to leave out.
 */
export type StepInput = z.input<typeof stepSchema>;

/** Narrow a step to a branch without repeating the shape check everywhere. */
export function isBranch(step: Step): step is { branch: BranchConfig } {
  return typeof step === "object" && step !== null && "branch" in step;
}

/** The path the video follows: the one marked default, else the first. */
export function defaultPath(branch: BranchConfig): BranchPath {
  return branch.paths.find((p) => p.default) ?? branch.paths[0]!;
}

/**
 * The steps that must run before `index` to put the app where that step expects
 * it. Earlier branches collapse to their default path, so a later branch's
 * alternates are recorded on top of the same trunk the video shows.
 */
export function trunkSteps(steps: Step[], index: number): BaseStep[] {
  const out: BaseStep[] = [];
  for (let i = 0; i < index; i++) {
    const s = steps[i]!;
    if (isBranch(s)) out.push(...defaultPath(s.branch).steps);
    else out.push(s);
  }
  return out;
}

/* ------------------------- Privacy & data ------------------------ */

/**
 * Redact sensitive regions so demos don't leak real data. Matching elements are
 * blurred (or boxed) in every captured frame via an injected MutationObserver,
 * so dynamically-added content (new rows, avatars) is covered too.
 * Accepts a bare list of CSS selectors or the full object form.
 */
export const redactSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { selectors: v } : v),
  z.object({
    selectors: z.array(z.string()).default([]),
    mode: z.enum(["blur", "box"]).default("blur"),
    blur: z.number().int().positive().default(12),
  }),
);
export type Redact = z.infer<typeof redactSchema>;

/**
 * Deterministic data — pin network responses so the demo shows clean, stable
 * content regardless of backend state. Replay a HAR and/or stub specific routes.
 */
export const mockSchema = z.object({
  har: z.string().optional(),
  routes: z
    .array(
      z.object({
        url: z.string(), // glob or URL prefix
        status: z.number().int().default(200),
        body: z.string().optional(),
        json: z.unknown().optional(),
        contentType: z.string().optional(),
      }),
    )
    .default([]),
});
export type Mock = z.infer<typeof mockSchema>;

/* ----------------------------- Spec ------------------------------ */

/**
 * Render one spec as several variants. A docs page usually needs the same flow
 * at desktop and mobile, and in both themes — that's the same demo four times,
 * and maintaining four specs guarantees they drift apart.
 *
 * Output paths template `{viewport}` and `{theme}` so the variants don't
 * collide.
 */
export const matrixSchema = z.object({
  viewports: z
    .array(viewportSchema.extend({ name: z.string().min(1) }))
    .nonempty()
    .optional(),
  themes: z.array(z.enum(["light", "dark"])).nonempty().optional(),
});
export type Matrix = z.infer<typeof matrixSchema>;

const specObject = z.object({
  /** Spec format version, so the grammar can evolve under semver. */
  version: z.literal(SPEC_VERSION).default(SPEC_VERSION),
  /** Shown on title cards and in the interactive build. */
  name: z.string().default("Untitled demo"),
  /** Where the demo starts. Any URL the browser can reach, not just localhost. */
  url: z.string().default("http://localhost:3000"),
  viewport: viewportSchema.default({}),
  /** The colour scheme the app is asked to render in (`prefers-color-scheme`). */
  theme: z.enum(["light", "dark"]).default("light"),
  run: runSchema.optional(),
  deterministic: deterministicSchema.default({}),
  polish: polishSchema.default({}),
  /**
   * Voice and timing for spoken narration. Top-level rather than under
   * `polish:` because it is not a look — every cut of a recording shares it.
   */
  audio: audioSchema.optional(),
  /** Playwright storageState path for logged-in demos. */
  storageState: z.string().optional(),
  /** Blur/box sensitive regions so demos don't leak real data. */
  redact: redactSchema.optional(),
  /** Pin network responses (HAR replay / route stubs) for clean, stable data. */
  mock: mockSchema.optional(),
  /**
   * Retry a step that fails for a transient reason (an element not ready yet,
   * a slow response). Only steps that provably didn't act are retried — a
   * timed-out click never clicked — so a retry can't double-submit a form or
   * type the same text twice.
   */
  retries: z.number().int().nonnegative().max(5).default(0),
  /** Render this one spec at several viewports and/or themes. */
  matrix: matrixSchema.optional(),
  /** Enable terminal steps, and configure how the terminal looks and behaves. */
  terminal: terminalSchema.optional(),
  /** The demo itself, in order. */
  steps: z.array(stepSchema).min(1),
  output: outputSchema,
  /**
   * Shorter deliverables cut out of this same recording.
   *
   * One demo usually has to be several: a long walkthrough for YouTube, a
   * minute for LinkedIn, forty seconds for Twitter, something much shorter for
   * a README. Written as separate specs they drift apart within a month — the
   * caption gets fixed in one and not the others — which is the failure this
   * whole tool exists to prevent.
   *
   * A cut is not a second recording. It names a range of the demo that was
   * already filmed and re-encodes the frames already on disk, so it costs no
   * browser time and cannot disagree with the master about what the app did.
   */
  cuts: z.array(cutSchema).optional(),
})
  /**
   * A key Reel does not recognize is an error, not something to ignore.
   *
   * Silently dropping it produces the worst outcome this tool can have: a spec
   * that renders, reports success, and quietly does less than it says. A demo
   * written against a newer Reel and run on an older one asked for four
   * deliverables and got one, with `cuts:` discarded and nothing said. A
   * misspelled `polish` key does the same on any version — the demo renders
   * without the thing you asked for and looks like it worked.
   *
   * Every step kind was already strict for exactly this reason; the top level
   * was not, which is where a version mismatch actually shows up.
   */
  .strict();

/**
 * A terminal-only demo has no app to load, so `url` must not fall back to a dev
 * server that isn't running — the navigation would stall before recording.
 */
export const specSchema = z.preprocess((v) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const raw = v as Record<string, unknown>;
    if (raw.terminal !== undefined && raw.url === undefined) {
      return { ...raw, url: "about:blank" };
    }
  }
  return v;
}, specObject);

/** The parsed, defaulted spec. */
export type Spec = z.infer<typeof specSchema>;

/**
 * The raw shape users write (before defaults are applied). Taken from the inner
 * object: the preprocess wrapper accepts `unknown` by construction, which would
 * erase the type for callers that build a spec programmatically.
 */
export type SpecInput = z.input<typeof specObject>;
