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

/* ---------------------------- Terminal ---------------------------- */

/**
 * Terminal demos. The terminal renders as a layer in the same page as the app,
 * so one spec can show a command and the browser it affects, and every existing
 * feature — zoom, captions, cards, device frames, encoding, the interactive
 * build — works on it unchanged.
 */
export const terminalSchema = z.object({
  cols: z.number().int().positive().max(300).default(90),
  rows: z.number().int().positive().max(120).default(24),
  /** Working directory for commands; relative to the spec file. */
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  /** The prompt drawn before each typed command. */
  prompt: z.string().default("$ "),
  title: z.string().default("zsh — reel"),
  background: cssColor.default("#0b0d12"),
  foreground: cssColor.default("#c9d1d9"),
  fontSize: z.number().int().positive().default(15),
  fontFamily: z.string().optional(),
  /** Per-character delay while the command is typed on camera (ms). */
  typing: z.number().int().nonnegative().default(55),
  /** Longest a single command may take before it's killed (ms). */
  timeout: z.number().int().positive().default(120_000),
  /**
   * Longest the captured output may take to stream back on camera (ms).
   * Output is replayed, not filmed live, so a slow command still reads fast.
   */
  replayMs: z.number().int().nonnegative().default(2200),
});
export type TerminalConfig = z.infer<typeof terminalSchema>;

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
const baseStepSchema = z.union([
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

export const stepSchema = z.union([
  baseStepSchema,
  z.object({ branch: branchSchema }).strict(),
]);
export type Step = z.infer<typeof stepSchema>;

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
  steps: z.array(stepSchema).min(1),
  output: outputSchema,
});

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
