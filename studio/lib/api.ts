export type LogLevel = "info" | "step" | "ok" | "warn" | "error" | "debug" | "phase";
export interface LogLine {
  level: LogLevel;
  msg: string;
}

export interface ConfigInfo {
  llm: {
    configured: boolean;
    model?: string;
    host?: string;
    provider?: string;
    protocol?: string;
    /** Why nothing resolved — already names the provider and the variable. */
    error?: string;
  };
  platform: string;
  /** Every provider Reel knows how to talk to. */
  providers?: { id: string; label: string }[];
  /**
   * Terminal colour schemes, served from `src/terminal/themes.ts`.
   *
   * Served rather than hand-copied: a scheme added to the source of truth shows
   * up here for free, and there is no second list to drift.
   */
  terminalThemes?: string[];
}

/** One `reel doctor` check, as the CLI reports it. */
export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** The command that fixes it, when there is one. */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}
export interface GallerySpec {
  path: string;
  name: string;
  url: string;
  outputs: { path: string; kind: string }[];
  kind: "web" | "terminal";
  stepCount: number;
  branchCount: number;
  variants: number;
}

export interface OutlineStep {
  index: number;
  kind: string;
  label: string;
  /** Terminal `run` steps only; undefined where hiding doesn't apply. */
  hidden?: boolean;
  branch?: {
    prompt: string;
    paths: { label: string; isDefault: boolean; steps: OutlineStep[] }[];
  };
}

/**
 * A structured read of a spec, built server-side from the same schema the
 * driver uses — so the Studio can't drift from the spec grammar, and the
 * options form shows what the spec actually says instead of defaults that
 * would silently overwrite it.
 */
/**
 * One schema complaint, with somewhere to go and look.
 *
 * `errors` is the readable one-liner; this is the same thing addressed. The
 * line is optional because a missing key has no line of its own — see
 * `locateIssue` in src/ui/summary.ts.
 */
export interface SpecIssue {
  path: string;
  message: string;
  /** 1-based line in the YAML, when the path maps onto one. */
  line?: number;
}

export interface SpecSummary {
  name: string;
  url: string;
  kind: "web" | "terminal";
  valid: boolean;
  errors: string[];
  issues: SpecIssue[];
  stepCount: number;
  outline: OutlineStep[];
  branchCount: number;
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
    /** Terminal demos only: the named colour scheme. */
    terminalTheme?: string;
    subtitles: boolean;
    languages: string[];
    /** The soundtrack, present even when the spec has no `audio:` block yet. */
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
    /** Reported, not offered: it counts towards "the spec renders something". */
    player?: string;
  };
}

/** One spoken line, as `reel narrate` reads it out of the spec. */
export interface ScriptLine {
  index: number;
  /** Which step it hangs off — a card title, a beat, or the step kind. */
  where: string;
  text: string;
  words: number;
  estimatedMs: number;
}

export interface Script {
  lines: ScriptLine[];
  words: number;
  estimatedMs: number;
  /** Cards and beats with nothing to say — what a draft would fill. */
  silent: string[];
}

/** A moment with nothing to say, and where in the spec to write a line. */
export interface SilentMoment {
  path: (string | number)[];
  kind: string;
  where: string;
}

/** What `/api/changed` knows about the pair a comparison would run on. */
export interface Comparable {
  /** Present when there are two renders to compare. */
  before?: string;
  after?: string;
  /** When the baseline copy was taken. */
  at?: number;
  /** The newer render, relative to the workspace. */
  file?: string;
  /** Why there is nothing to compare, when there isn't. */
  why?: string;
}

/** One stretch of the demo that differs, as `reel diff` reports it. */
export interface DiffRange {
  startMs: number;
  endMs: number;
  mean: number;
  beats: string[];
  truncated?: boolean;
}

export interface DiffResult {
  identical: boolean;
  samples: number;
  changedSamples: number;
  changedFraction: number;
  durationBeforeMs: number;
  durationAfterMs: number;
  ranges: DiffRange[];
  /** Before / after / difference images, one per range; "" where there is none. */
  strips: string[];
}

export type Verdict = "cosmetic" | "content" | "stale-caption" | "unreviewed";

export interface ReviewFinding {
  startMs: number;
  endMs: number;
  verdict: Verdict;
  summary: string;
  beats: string[];
  captions: string[];
}

export interface ReviewResult {
  findings: ReviewFinding[];
  model: string | null;
  skipped: number;
  diff: DiffResult;
  /** Set when no model was configured and only the pixel pass ran. */
  unconfigured?: string;
}

/** A proposal from `reel direct`, with the reason it was made. */
export interface Direction {
  index: number;
  step: unknown;
  because: string;
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export async function postJSON<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export interface JobDone {
  ok: boolean;
  result?: any;
  error?: string;
  hint?: string;
  /** The job stopped because it was asked to — a decision, not a failure. */
  cancelled?: boolean;
}

/**
 * Ask the server to stop the running job.
 *
 * Only a render and a drift check can actually be stopped; the server says so
 * rather than pretending, and the UI only offers the button for those.
 */
export async function cancelJob(): Promise<{ ok: boolean; error?: string; hint?: string }> {
  return postJSON("/api/cancel", {});
}

/**
 * POST a streaming job and receive live NDJSON: `onLog` for each log line, and
 * the resolved promise carries the final result. Returns 409 as an error if a
 * job is already running server-side.
 */
export async function runJob(
  url: string,
  body: unknown,
  onLog: (line: LogLine) => void,
): Promise<JobDone> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    // The server names the job that holds the slot, which is the difference
    // between "wait" and "stop the render you started by mistake".
    const busy = await res.json().catch(() => ({}) as { error?: string });
    return { ok: false, error: busy.error ?? "A job is already running. Wait for it to finish." };
  }
  if (!res.body) return { ok: false, error: "No response stream." };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done: JobDone = { ok: false, error: "stream ended without a result" };

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "log") onLog({ level: obj.level, msg: obj.msg });
        else if (obj.type === "done") done = obj;
        // Anything else is ignored on purpose. The server sends `{type:"ping"}`
        // every few seconds so that a proxy between us — Next's dev rewrite, in
        // the normal setup — never sees an idle connection during the minutes a
        // render spends compositing without logging anything. Dropping unknown
        // types here is what lets the server add such lines without a lockstep
        // client release.
      } catch {
        /* ignore malformed line */
      }
    }
  }
  return done;
}

export function mediaUrl(path: string): string {
  return `/media?path=${encodeURIComponent(path)}`;
}
