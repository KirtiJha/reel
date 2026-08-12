import http from "node:http";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, dirname, resolve, relative, isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadSpec } from "../spec/load.js";
import { specSchema } from "../spec/schema.js";
import { record, check } from "../driver/run.js";
import { heal } from "../heal/heal.js";
import { authorSpec } from "../ai/author.js";
import { addLogSink, log, ReelError } from "../util/log.js";
import { loadLlmConfig } from "../ai/llm.js";

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".ico": "image/x-icon",
  // Interactive builds are self-contained pages — serve them as pages so the
  // Studio can preview one in an iframe instead of downloading it.
  ".html": "text/html; charset=utf-8",
};

let busy = false; // one in-process job at a time keeps the log stream clean

/** Start the in-process API + media server (the Next.js UI proxies to it). */
export async function startApiServer(port: number): Promise<http.Server> {
  const cwd = process.cwd();
  const server = http.createServer((req, res) => {
    // Permit the Next dev origin to call the API directly if ever needed.
    res.setHeader("access-control-allow-origin", "*");
    handle(req, res, cwd).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
  });
  await new Promise<void>((r) => server.listen(port, r));
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): Promise<void> {
  const u = new URL(req.url ?? "/", "http://localhost");
  const path = u.pathname;

  // --- Read-only API ---
  if (path === "/api/config" && req.method === "GET") return sendJson(res, 200, await getConfig());
  if (path === "/api/specs" && req.method === "GET") return sendJson(res, 200, { specs: await listSpecs(cwd) });
  if (path === "/api/gallery" && req.method === "GET") return sendJson(res, 200, { specs: await gallery(cwd) });
  if (path === "/api/patch" && req.method === "POST") {
    const body = await readBody(req);
    let parsed: any = {};
    try {
      parsed = parseYaml(String(body.raw ?? "")) ?? {};
    } catch {
      parsed = {};
    }
    deepMerge(parsed, body.patch ?? {});
    return sendJson(res, 200, { raw: stringifyYaml(parsed, { lineWidth: 0 }) });
  }
  if (path === "/api/spec" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return sendJson(res, 400, { error: "bad path" });
    try {
      return sendJson(res, 200, { raw: await readFile(p, "utf8") });
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
  }
  // Already-rendered artifacts for a spec, so opening one in Studio shows the
  // last render instead of an empty panel until you record again.
  if (path === "/api/outputs" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return sendJson(res, 400, { error: "bad path" });
    return sendJson(res, 200, { outputs: await renderedOutputs(p, cwd) });
  }
  if (path === "/media" && req.method === "GET") {
    const p = safePath(cwd, u.searchParams.get("path") ?? "");
    if (!p) return void sendJson(res, 400, { error: "bad path" });
    return serveMedia(req, res, p);
  }

  // --- Mutations / jobs ---
  if (path === "/api/spec" && req.method === "POST") return saveSpec(req, res, cwd);
  if (path === "/api/record" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const loaded = await loadSpec(safePathOrThrow(cwd, body.path));
      const r = await record(loaded, "record");
      return { outputs: r.outputs.map((o) => rel(cwd, o)), frames: r.frames, durationMs: r.durationMs };
    });
  }
  if (path === "/api/check" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      await check(await loadSpec(safePathOrThrow(cwd, body.path)));
      return { passed: true };
    });
  }
  if (path === "/api/heal" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const r = await heal(await loadSpec(safePathOrThrow(cwd, body.path)), { write: Boolean(body.write) });
      return r;
    });
  }
  if (path === "/api/author" && req.method === "POST") {
    const body = await readBody(req);
    return streamJob(res, async () => {
      const out = safePathOrThrow(cwd, body.out || "demo.reel.yaml");
      await authorSpec(String(body.story ?? ""), { url: String(body.url ?? ""), out, model: body.model || undefined });
      return { path: rel(cwd, out), raw: await readFile(out, "utf8") };
    });
  }

  sendJson(res, 404, { error: "not found" });
}

/* ------------------------------ helpers ------------------------------ */

async function getConfig() {
  let llm: { configured: boolean; model?: string; host?: string } = { configured: false };
  try {
    const cfg = loadLlmConfig();
    llm = { configured: true, model: cfg.model, host: new URL(cfg.apiBase).host };
  } catch {
    /* not configured */
  }
  return { llm, platform: process.platform };
}

async function listSpecs(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", ".reel-cache"]);
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(full, depth + 1);
      } else if (e.name.endsWith(".reel.yaml") || e.name.endsWith(".reel.yml")) {
        out.push(rel(cwd, full));
      }
    }
  };
  await walk(cwd, 0);
  return out.sort();
}

export interface GallerySpec {
  path: string;
  name: string;
  url: string;
  outputs: { path: string; kind: string }[];
}

/** Specs plus whichever of their declared outputs actually exist on disk. */
/**
 * The artifacts a spec declares that actually exist on disk. Derived from the
 * spec rather than by scanning a directory, so an unrelated file next to the
 * output never shows up as part of the demo. Subtitle sidecars are derived the
 * same way `record` names them.
 */
async function renderedOutputs(
  specPath: string,
  cwd: string,
): Promise<{ path: string; kind: string }[]> {
  let parsed: any;
  try {
    parsed = parseYaml(await readFile(specPath, "utf8"));
  } catch {
    return [];
  }
  const dir = dirname(specPath);
  const o = parsed?.output ?? {};
  const abs = (p: string) => (isAbsolute(p) ? p : join(dir, p));

  const candidates: { p?: string; kind: string }[] = [
    { p: o.mp4, kind: "mp4" },
    { p: o.gif, kind: "gif" },
    { p: o.webm, kind: "webm" },
    { p: o.storyboard, kind: "storyboard" },
    { p: o.html, kind: "html" },
  ];

  // Subtitles land beside the video, named after it (or at an explicit base).
  let subBase: string | undefined;
  if (o.subtitles === true) {
    const src = o.mp4 ?? o.webm ?? o.gif;
    if (src) subBase = String(src).replace(/\.[^.]+$/, "");
  } else if (typeof o.subtitles === "string") {
    subBase = o.subtitles.replace(/\.(srt|vtt)$/i, "");
  }
  if (subBase) {
    const langs: string[] = Array.isArray(o.languages) ? o.languages : [];
    for (const base of [subBase, ...langs.map((l) => `${subBase}.${l}`)]) {
      candidates.push({ p: `${base}.srt`, kind: "srt" }, { p: `${base}.vtt`, kind: "vtt" });
    }
  }

  const outputs: { path: string; kind: string }[] = [];
  for (const c of candidates) {
    if (!c.p) continue;
    const fp = abs(String(c.p));
    try {
      await stat(fp);
      outputs.push({ path: rel(cwd, fp), kind: c.kind });
    } catch {
      /* not rendered yet */
    }
  }
  return outputs;
}

async function gallery(cwd: string): Promise<GallerySpec[]> {
  const paths = await listSpecs(cwd);
  const out: GallerySpec[] = [];
  for (const rp of paths) {
    const full = join(cwd, rp);
    let parsed: any;
    try {
      parsed = parseYaml(await readFile(full, "utf8"));
    } catch {
      continue;
    }
    out.push({
      path: rp,
      name: parsed?.name ?? rp,
      url: parsed?.url ?? "",
      outputs: await renderedOutputs(full, cwd),
    });
  }
  return out;
}

function deepMerge(target: any, patch: any): any {
  for (const k of Object.keys(patch ?? {})) {
    const v = patch[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      deepMerge(target[k], v);
    } else if (v === null) {
      delete target[k];
    } else {
      target[k] = v;
    }
  }
  return target;
}

async function saveSpec(req: http.IncomingMessage, res: http.ServerResponse, cwd: string): Promise<void> {
  const body = await readBody(req);
  const p = safePath(cwd, String(body.path ?? ""));
  if (!p) return sendJson(res, 400, { error: "bad path" });
  const raw = String(body.raw ?? "");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: `YAML: ${(e as Error).message}` });
  }
  const check = specSchema.safeParse(parsed);
  await writeFile(p, raw, "utf8"); // the user owns the file; save even if incomplete
  if (!check.success) {
    return sendJson(res, 200, {
      ok: true,
      warnings: check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }
  sendJson(res, 200, { ok: true });
}

/** Run a job in-process, streaming logs + a final result as NDJSON. */
function streamJob(res: http.ServerResponse, run: () => Promise<unknown>): void {
  if (busy) return void sendJson(res, 409, { error: "A job is already running. Wait for it to finish." });
  busy = true;
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
  const unsub = addLogSink((e) => write({ type: "log", ...e }));
  run()
    .then((result) => write({ type: "done", ok: true, result }))
    .catch((err) => {
      const e = err as ReelError;
      write({ type: "done", ok: false, error: e.message, hint: e.hint });
    })
    .finally(() => {
      unsub();
      busy = false;
      res.end();
    });
}

async function serveMedia(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<void> {
  let s;
  try {
    s = await stat(p);
  } catch {
    return void sendJson(res, 404, { error: "not found" });
  }
  const type = MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : s.size - 1;
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${start}-${end}/${s.size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    createReadStream(p, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "content-type": type, "content-length": s.size, "accept-ranges": "bytes" });
    createReadStream(p).pipe(res);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Resolve a user path within cwd; returns null on traversal outside cwd. */
function safePath(cwd: string, p: string): string | null {
  if (!p) return null;
  const full = isAbsolute(p) ? p : resolve(cwd, p);
  const r = relative(cwd, full);
  if (r.startsWith("..") || isAbsolute(r)) return null;
  return full;
}
function safePathOrThrow(cwd: string, p: string): string {
  const s = safePath(cwd, String(p ?? ""));
  if (!s) throw new ReelError(`Invalid path: ${p}`);
  return s;
}
function rel(cwd: string, p: string): string {
  return isAbsolute(p) ? relative(cwd, p) : p;
}
