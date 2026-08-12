export type LogLevel = "info" | "step" | "ok" | "warn" | "error" | "debug" | "phase";
export interface LogLine {
  level: LogLevel;
  msg: string;
}

export interface ConfigInfo {
  llm: { configured: boolean; model?: string; host?: string };
  platform: string;
}
export interface GallerySpec {
  path: string;
  name: string;
  url: string;
  outputs: { path: string; kind: string }[];
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
