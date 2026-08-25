import { parse as parseYaml } from "yaml";
import {
  defaultPath,
  isBranch,
  specSchema,
  type BaseStep,
  type Spec,
  type Step,
} from "../spec/schema.js";

/**
 * A structured read of a spec, for the Studio.
 *
 * Built from the same zod schema the driver uses, so the UI can never drift
 * from the grammar: a step kind the schema knows about shows up here for free,
 * and one it doesn't is reported as invalid rather than rendered as if it were
 * fine. It also means the options form can show what the spec *actually* says
 * instead of a set of defaults that quietly overwrite it.
 */

export interface OutlineStep {
  /** 1-based position in the top-level step list. */
  index: number;
  /** The step's single key: click, caption, run, branch… */
  kind: string;
  /** A short human description. */
  label: string;
  /**
   * Terminal `run` steps only: the command executes but is never filmed.
   * Undefined on every other kind, so the UI can tell "not hidden" from
   * "hiding doesn't apply here".
   */
  hidden?: boolean;
  /** Present on a branch step. */
  branch?: {
    prompt: string;
    paths: { label: string; isDefault: boolean; steps: OutlineStep[] }[];
  };
}

export interface SpecSummary {
  name: string;
  url: string;
  /** A terminal spec drives a rendered terminal instead of (or beside) a page. */
  kind: "web" | "terminal";
  valid: boolean;
  errors: string[];
  stepCount: number;
  outline: OutlineStep[];
  branchCount: number;
  /** Number of rendered variants (viewport × theme); 1 when there's no matrix. */
  variants: number;
  matrix?: { viewports: string[]; themes: string[] };
  options: {
    preset: string;
    frame: string;
    speed: number;
    trimIdle?: number;
    targetDuration?: string;
    retries: number;
    timeline: boolean;
    captions: boolean;
    zoom: boolean;
    /** Terminal demos only: whether the camera follows each command's output. */
    zoomOutput: boolean;
    zoomRows: number;
    /** Terminal demos only: the named colour scheme. Undefined for web specs. */
    terminalTheme?: string;
    subtitles: boolean;
    languages: string[];
    /**
     * The soundtrack, or its absence.
     *
     * Present even when the spec has no `audio:` block, so the Studio can offer
     * to add one rather than only edit one that already exists.
     */
    audio: {
      enabled: boolean;
      provider: string;
      voiceId?: string;
      fit: string;
      sfx: string;
      music?: string;
      musicGain?: number;
      musicDuck?: number;
      /** How many steps actually carry a spoken line. */
      spokenLines: number;
    };
    html?: string;
    gif?: string;
    mp4?: string;
    webm?: string;
    storyboard?: string;
  };
}

/** The single key that identifies a step. */
function kindOf(step: Step | BaseStep): string {
  return Object.keys(step)[0] ?? "step";
}

/** A short description, mirroring how the driver logs each step. */
function labelOf(step: Step | BaseStep): string {
  const key = kindOf(step);
  const value = (step as Record<string, unknown>)[key];
  if (value === true || value === undefined) return key;
  if (typeof value === "string" || typeof value === "number") return `${key} ${value}`;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if ("cmd" in v) return `${key} ${String(v.cmd)}`;
    if ("title" in v) return `${key} “${String(v.title)}”`;
    if ("prompt" in v) return `${key} “${String(v.prompt)}”`;
    if ("selector" in v) {
      return `${key} ${String(v.selector)}${"text" in v ? ` “${String(v.text)}”` : ""}`;
    }
    if ("to" in v) return `${key} ${String(v.to)}`;
    if ("text" in v) return `${key} ${String(v.text)}`;
  }
  return key;
}

function outlineOf(steps: (Step | BaseStep)[], from = 1): OutlineStep[] {
  return steps.map((step, i) => {
    const entry: OutlineStep = {
      index: from + i,
      kind: kindOf(step),
      label: labelOf(step),
    };
    if (entry.kind === "run") {
      const run = (step as { run: unknown }).run;
      // The shorthand `- run: ls` is never hidden; only the object form can be.
      entry.hidden = typeof run === "object" && run !== null && (run as { hidden?: boolean }).hidden === true;
    }
    if (isBranch(step as Step)) {
      const b = (step as { branch: Parameters<typeof defaultPath>[0] }).branch;
      const chosen = defaultPath(b);
      entry.branch = {
        prompt: b.prompt,
        paths: b.paths.map((p) => ({
          label: p.label,
          isDefault: p === chosen,
          steps: outlineOf(p.steps, 1),
        })),
      };
    }
    return entry;
  });
}

/**
 * How many steps would be spoken.
 *
 * Worth surfacing on its own: `audio:` can be configured perfectly and still
 * produce silence if nothing carries a line, and "narration is on" next to a
 * count of zero is the fastest way to see that.
 */
function countSpoken(steps: (Step | BaseStep)[]): number {
  let n = 0;
  for (const step of steps) {
    if (isBranch(step as Step)) {
      n += countSpoken(defaultPath((step as { branch: Parameters<typeof defaultPath>[0] }).branch).steps);
      continue;
    }
    const s = step as Record<string, unknown>;
    if ("say" in s) n++;
    else if ("caption" in s) {
      const c = s.caption;
      // A bare string caption is spoken; the object form can opt out.
      if (typeof c === "string") n++;
      else if (c && typeof c === "object" && (c as { say?: unknown }).say !== false) n++;
    } else if ("card" in s) {
      const c = s.card;
      // Cards are silent unless given a line — a title read aloud is a title.
      if (c && typeof c === "object" && (c as { say?: unknown }).say) n++;
    }
  }
  return n;
}

function optionsOf(spec: Spec): SpecSummary["options"] {
  const o = spec.output;
  return {
    preset: o.preset,
    frame: spec.polish.frame,
    speed: spec.polish.speed,
    trimIdle: spec.polish.trimIdle,
    targetDuration: o.targetDuration === undefined ? undefined : String(o.targetDuration),
    retries: spec.retries,
    timeline: spec.deterministic.timeline,
    captions: spec.polish.captions,
    zoom: spec.polish.zoom === "auto",
    zoomOutput: spec.polish.zoomOutput,
    zoomRows: spec.polish.zoomRows,
    terminalTheme: spec.terminal?.theme,
    subtitles: Boolean(o.subtitles),
    languages: o.languages ?? [],
    audio: {
      enabled: Boolean(spec.audio) && o.audio !== false,
      provider: spec.audio?.voice.provider ?? "elevenlabs",
      voiceId: spec.audio?.voice.id,
      fit: spec.audio?.fit ?? "stretch",
      sfx: spec.audio?.sfx ?? "none",
      music: spec.audio?.music?.file,
      musicGain: spec.audio?.music?.gain,
      musicDuck: spec.audio?.music?.duck,
      spokenLines: countSpoken(spec.steps),
    },
    html: o.html,
    gif: o.gif,
    mp4: o.mp4,
    webm: o.webm,
    storyboard: o.storyboard,
  };
}

/** Parse a spec's YAML into the shape the Studio renders. */
export function summarize(raw: string): SpecSummary {
  const empty: SpecSummary = {
    name: "",
    url: "",
    kind: "web",
    valid: false,
    errors: [],
    stepCount: 0,
    outline: [],
    branchCount: 0,
    variants: 1,
    options: {
      preset: "share",
      frame: "none",
      speed: 1,
      retries: 0,
      timeline: true,
      captions: true,
      zoom: true,
      zoomOutput: false,
      zoomRows: 12,
      subtitles: false,
      languages: [],
      audio: {
        enabled: false,
        provider: "elevenlabs",
        fit: "stretch",
        sfx: "none",
        spokenLines: 0,
      },
    },
  };

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    return { ...empty, errors: [(err as Error).message] };
  }

  const parsed = specSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ...empty,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  const spec = parsed.data;
  const viewports = spec.matrix?.viewports?.map((v) => v.name) ?? [];
  const themes = spec.matrix?.themes ?? [];
  const variants = Math.max(1, (viewports.length || 1) * (themes.length || 1));

  return {
    name: spec.name,
    url: spec.url,
    kind: spec.terminal ? "terminal" : "web",
    valid: true,
    errors: [],
    stepCount: spec.steps.length,
    outline: outlineOf(spec.steps),
    branchCount: spec.steps.filter((s) => isBranch(s)).length,
    variants,
    matrix: spec.matrix ? { viewports, themes } : undefined,
    options: optionsOf(spec),
  };
}
