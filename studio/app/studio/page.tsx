"use client";
import { useCallback, useEffect, useState } from "react";
import { PageHead, Spinner, Toggle } from "@/components/bits";
import { LogConsole } from "@/components/LogConsole";
import { MediaPreview } from "@/components/MediaPreview";
import { getJSON, postJSON, runJob, type LogLine } from "@/lib/api";

const PRESETS = ["share", "readme", "social", "hq", "docs"];
const FRAMES = ["none", "browser", "window"];

export default function StudioPage() {
  const [specs, setSpecs] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [raw, setRaw] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // output-options form
  const [preset, setPreset] = useState("share");
  const [frame, setFrame] = useState("browser");
  const [subtitles, setSubtitles] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [languages, setLanguages] = useState("");

  // job
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  /** True when the preview is a previous render rather than this session's. */
  const [stale, setStale] = useState(false);

  const loadSpec = useCallback(async (p: string) => {
    setPath(p);
    setOutputs([]);
    setNote(null);
    setStale(false);
    if (!p) return setRaw("");
    const r = await getJSON<{ raw?: string }>(`/api/spec?path=${encodeURIComponent(p)}`).catch(() => ({ raw: "" }));
    setRaw(r.raw ?? "");
    // Show whatever this spec last rendered, so opening a demo from the gallery
    // isn't a blank panel until you record it again.
    const prior = await getJSON<{ outputs: { path: string }[] }>(
      `/api/outputs?path=${encodeURIComponent(p)}`,
    ).catch(() => ({ outputs: [] }));
    if (prior.outputs.length) {
      setOutputs(prior.outputs.map((o) => o.path));
      setStale(true);
    }
  }, []);

  useEffect(() => {
    getJSON<{ specs: string[] }>("/api/specs").then((d) => setSpecs(d.specs)).catch(() => {});
    const p = new URLSearchParams(window.location.search).get("path");
    if (p) loadSpec(p);
  }, [loadSpec]);

  async function save() {
    const r = await postJSON<{ ok: boolean; error?: string; warnings?: string[] }>("/api/spec", { path, raw });
    if (r.error) {
      setWarnings([r.error]);
      return false;
    }
    setWarnings(r.warnings ?? []);
    setNote("Saved.");
    return true;
  }

  async function applyOptions() {
    const patch: any = { output: { preset }, polish: { frame } };
    patch.output.subtitles = subtitles ? true : null;
    // Name the interactive build after the spec, so it lands beside the video.
    const base = path.split("/").pop()?.replace(/\.reel\.ya?ml$/i, "") || "demo";
    patch.output.html = interactive ? `out/${base}.html` : null;
    patch.output.languages = languages.trim()
      ? languages.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    const r = await postJSON<{ raw: string }>("/api/patch", { raw, patch });
    setRaw(r.raw);
    setNote("Options applied — review and Save.");
  }

  async function job(kind: "record" | "check" | "heal", extra: Record<string, unknown> = {}) {
    if (!(await save())) return;
    setRunning(kind);
    setLogs([]);
    setOutputs([]);
    setNote(null);
    const done = await runJob(`/api/${kind}`, { path, ...extra }, (l) => setLogs((p) => [...p, l]));
    setRunning(null);
    if (!done.ok) {
      setNote(done.hint ? `${done.error} — ${done.hint}` : done.error ?? "failed");
      return;
    }
    if (kind === "record") {
      setOutputs(done.result?.outputs ?? []);
      setStale(false);
    }
    if (kind === "check") setNote("✓ Drift check passed — every step still works.");
    if (kind === "heal") {
      const fixes = done.result?.fixes ?? [];
      const unresolved = done.result?.unresolved ?? [];
      setNote(
        fixes.length || unresolved.length
          ? `${fixes.length} repaired, ${unresolved.length} unresolved.`
          : "No drift — every step works.",
      );
      if (fixes.length) loadSpec(path); // reload the rewritten spec
    }
  }

  return (
    <div>
      <PageHead eyebrow="Studio" title="Edit, render, and preview" sub="Tune the spec and output, then record — or verify and self-heal it against the live app." />

      <div className="grid grid-cols-[1.15fr_1fr] gap-5 max-[980px]:grid-cols-1">
        {/* left: spec + editor + options */}
        <div>
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <select className="input" value={path} onChange={(e) => loadSpec(e.target.value)}>
                <option value="">Select a spec…</option>
                {specs.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button className="btn btn-sm" onClick={() => getJSON<{ specs: string[] }>("/api/specs").then((d) => setSpecs(d.specs))} title="Refresh">
                ↻
              </button>
            </div>
            <textarea
              className="input min-h-[300px] resize-y font-mono text-[12.5px] leading-relaxed"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              spellCheck={false}
              placeholder="Select a spec to edit its YAML…"
            />
            <div className="mt-3 flex items-center gap-3">
              <button className="btn btn-primary btn-sm" onClick={save} disabled={!path}>
                Save
              </button>
              {note && <span className="text-sm text-muted">{note}</span>}
            </div>
            {warnings.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[12.5px] text-warn">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2 className="mb-4 text-base font-semibold">Output & polish</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">Preset</span>
                <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
                  {PRESETS.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Device frame</span>
                <select className="input" value={frame} onChange={(e) => setFrame(e.target.value)}>
                  {FRAMES.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 rounded-xl border border-line bg-bg2 p-3.5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Interactive HTML</div>
                  <div className="text-xs text-faint">
                    A self-contained click-through with hotspots — one file, no hosting.
                  </div>
                </div>
                <Toggle checked={interactive} onChange={setInteractive} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Toggle checked={subtitles} onChange={setSubtitles} label="Subtitles (SRT/VTT)" />
              <label className="flex items-center gap-2">
                <span className="label mb-0">Localize</span>
                <input className="input !w-40 !py-1.5" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="es, fr" />
              </label>
            </div>

            <button className="btn btn-sm mt-4" onClick={applyOptions} disabled={!path}>
              Apply to spec
            </button>
          </div>
        </div>

        {/* right: actions + logs + preview */}
        <div>
          <div className="card">
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={() => job("record")} disabled={!path || !!running}>
                {running === "record" ? <Spinner /> : "●"} Record
              </button>
              <button className="btn" onClick={() => job("check")} disabled={!path || !!running}>
                {running === "check" ? <Spinner /> : "✓"} Check drift
              </button>
              <button className="btn" onClick={() => job("heal", { write: true })} disabled={!path || !!running}>
                {running === "heal" ? <Spinner /> : "✚"} Heal
              </button>
            </div>
            <div className="mt-4">
              <LogConsole lines={logs} running={!!running} />
            </div>
          </div>

          {outputs.length > 0 && (
            <div className="card">
              <div className="mb-3 flex items-center gap-2.5">
                <h2 className="text-base font-semibold">Preview</h2>
                {stale && (
                  <span className="tag" title="Rendered by an earlier run — record to refresh">
                    last render
                  </span>
                )}
              </div>
              <MediaPreview outputs={outputs} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
