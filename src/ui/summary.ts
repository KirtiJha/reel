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
    subtitles: boolean;
    languages: string[];
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
    subtitles: Boolean(o.subtitles),
    languages: o.languages ?? [],
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
      subtitles: false,
      languages: [],
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
