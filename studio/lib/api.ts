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
export interface SpecSummary {
  name: string;
  url: string;
  kind: "web" | "terminal";
  valid: boolean;
  errors: string[];
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
  };
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
  if (res.status === 409) return { ok: false, error: "A job is already running. Wait for it to finish." };
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
