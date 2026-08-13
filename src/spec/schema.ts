import { z } from "zod";

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

export const polishSchema = z.object({
  /** auto = zoom toward the active element; false = never zoom. */
  zoom: z.union([z.literal("auto"), z.literal(false)]).default("auto"),
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
   * Cap any stretch where nothing on screen changes at this many ms. Dead air
   * — waiting out a slow save, a long declared hold — is what makes a demo
   * drag; this trims it without touching the moments that move.
   */
  trimIdle: z.number().int().positive().optional(),
});
export type Polish = z.infer<typeof polishSchema>;

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

/* ----------------------------- Steps ----------------------------- */

const selector = z.string().min(1);
const durationMs = z.number().int().nonnegative();

/**
 * Steps are expressed as single-key objects so YAML stays terse and readable:
 *   - goto: /
 *   - click: text=Get started
 *   - type: { selector: "#email", text: "you@acme.com" }
 *
 * Every action step auto-waits (Playwright semantics) and, where it makes
 * sense, records a `beat` so the encoder holds on meaningful frames.
 */
export const stepSchema = z.union([
  z.object({ goto: z.string() }).strict(),
  z.object({ click: selector }).strict(),
  z.object({ dblclick: selector }).strict(),
  z.object({ hover: selector }).strict(),
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
  z.object({ press: z.object({ selector: selector.optional(), key: z.string() }) }).strict(),
  z.object({ fill: z.object({ selector, text: z.string() }) }).strict(),
  z.object({ scrollTo: selector }).strict(),
  /** State-based wait — the reliability moat. Never a raw sleep by default. */
  z.object({ waitFor: selector }).strict(),
  z.object({ waitForUrl: z.string() }).strict(),
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
        to: selector.optional(),
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
]);
export type Step = z.infer<typeof stepSchema>;

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

export const specSchema = z.object({
  version: z.literal(SPEC_VERSION).default(SPEC_VERSION),
  name: z.string().default("Untitled demo"),
  url: z.string().default("http://localhost:3000"),
  viewport: viewportSchema.default({}),
  theme: z.enum(["light", "dark"]).default("light"),
  run: runSchema.optional(),
  deterministic: deterministicSchema.default({}),
  polish: polishSchema.default({}),
  /** Playwright storageState path for logged-in demos. */
  storageState: z.string().optional(),
  /** Blur/box sensitive regions so demos don't leak real data. */
  redact: redactSchema.optional(),
  /** Pin network responses (HAR replay / route stubs) for clean, stable data. */
  mock: mockSchema.optional(),
  steps: z.array(stepSchema).min(1),
  output: outputSchema,
});

/** The parsed, defaulted spec. */
export type Spec = z.infer<typeof specSchema>;

/** The raw shape users write (before defaults are applied). */
export type SpecInput = z.input<typeof specSchema>;
