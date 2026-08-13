import { stringify } from "yaml";
import type { StepInput } from "../spec/schema.js";
import { schemaDirective } from "../commands/schema.js";

/**
 * Writing the captured steps out as a spec.
 *
 * Deliberately hand-formatted rather than dumped by the YAML serializer. The
 * output of `reel capture` is a file somebody is going to open and edit — it is
 * a draft, not an artifact — so it has to look like the specs in the examples:
 * one step per line, small maps inline, the optional knobs present but
 * commented so they can be discovered without reading the docs.
 *
 * A serializer produces a correct file that reads like machine output, and a
 * demo nobody wants to edit stops being maintained.
 */

export interface EmitOptions {
  name: string;
  url: string;
  steps: StepInput[];
  /** Output paths, relative to the spec. */
  gif: string;
  mp4?: string;
}

export function emitSpec(opts: EmitOptions): string {
  const steps = opts.steps.length
    ? opts.steps.map((s) => `  ${renderStep(s)}`).join("\n")
    : "  # Nothing was captured — record again and interact with the app.\n  - goto: /";

  return `${schemaDirective()}
# Captured with \`reel capture\`. This is a draft: rename it, add captions and
# beats where the demo should breathe, and delete anything incidental.
name: ${scalar(opts.name)}
url: ${scalar(opts.url)}
viewport: { width: 1280, height: 800, scale: 2 }
theme: light

# Freeze everything that would otherwise differ between runs, so the same spec
# renders the same media on your laptop and in CI.
deterministic:
  disableAnimations: true
  freezeClock: "2026-01-01T12:00:00Z"
  locale: en-US
  timezone: UTC

polish:
  zoom: auto
  cursor: smooth
  captions: true
  # frame: browser               # macOS-style window with a URL pill
  # background: "linear-gradient(135deg, #2b3a67, #1a1f36)"

steps:
${steps}

output:
  # preset: share (default) · readme · social · hq · docs
  preset: share
  gif: ${scalar(opts.gif)}${opts.mp4 ? `\n  mp4: ${scalar(opts.mp4)}` : ""}
  # html: out/demo.html          # self-contained interactive click-through
`;
}

/** `- click: role=button[name=Add]` / `- type: { selector: "#a", text: "hi" }` */
export function renderStep(step: StepInput): string {
  const key = Object.keys(step)[0]!;
  const value = (step as Record<string, unknown>)[key];

  if (value === null || typeof value !== "object") return `- ${key}: ${scalar(value)}`;

  const inner = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${scalar(v, true)}`)
    .join(", ");
  return `- ${key}: { ${inner} }`;
}

/**
 * A scalar the YAML parser will read back as what was written.
 *
 * The serializer decides whether quotes are needed — it knows the whole grammar
 * of plain scalars, and a hand-rolled rule that gets `#task-input` or `yes`
 * wrong produces a spec that parses to the wrong thing rather than failing.
 *
 * `flow` covers what block-context serialization has no reason to consider: a
 * comma or a bracket ends the value inside `{ … }`, so `role=button[name=Add]`
 * is fine on a line of its own and needs quoting in an inline map.
 */
export function scalar(value: unknown, flow = false): string {
  const out = stringify(value, { lineWidth: 0 }).trimEnd();
  if (flow && /^[^"']/.test(out) && /[,{}[\]]/.test(out)) return JSON.stringify(String(value));
  return out;
}
