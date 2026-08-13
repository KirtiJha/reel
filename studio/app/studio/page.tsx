"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, Spinner, Toggle } from "@/components/bits";
import { LogConsole } from "@/components/LogConsole";
import { MediaPreview } from "@/components/MediaPreview";
import { SpecChips, SpecOutline } from "@/components/SpecOutline";
import { getJSON, postJSON, runJob, type LogLine, type SpecSummary } from "@/lib/api";

const PRESETS = ["share", "readme", "social", "hq", "docs"];
const FRAMES = ["none", "browser", "window"];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function StudioPage() {
  const [specs, setSpecs] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [raw, setRaw] = useState("");
  const [summary, setSummary] = useState<SpecSummary | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  // output-options form, hydrated from the spec rather than from defaults
  const [preset, setPreset] = useState("share");
  const [frame, setFrame] = useState("browser");
  const [subtitles, setSubtitles] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [languages, setLanguages] = useState("");
  const [speed, setSpeed] = useState(1);
  const [targetDuration, setTargetDuration] = useState("");
  const [retries, setRetries] = useState(0);
  const [timeline, setTimeline] = useState(true);

  // job
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  /** True when the preview is a previous render rather than this session's. */
  const [stale, setStale] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<"yaml" | "steps">("yaml");

  /** Fill the form from what the spec says, so applying can't clobber it. */
  const hydrate = useCallback((s: SpecSummary | null) => {
    setSummary(s);
    if (!s?.valid) return;
    setPreset(s.options.preset);
    setFrame(s.options.frame);
    setSubtitles(s.options.subtitles);
    setInteractive(Boolean(s.options.html));
    setLanguages(s.options.languages.join(", "));
    setSpeed(s.options.speed);
    setTargetDuration(s.options.targetDuration ?? "");
    setRetries(s.options.retries);
    setTimeline(s.options.timeline);
  }, []);

  const loadSpec = useCallback(
    async (p: string) => {
      setPath(p);
      setOutputs([]);
      setNote(null);
      setStale(false);
      setDirty(false);
      if (!p) {
        setRaw("");
        setSummary(null);
        return;
      }
      const r = await getJSON<{ raw?: string; summary?: SpecSummary }>(
        `/api/spec?path=${encodeURIComponent(p)}`,
      ).catch(() => ({ raw: "", summary: undefined }));
      setRaw(r.raw ?? "");
      hydrate(r.summary ?? null);
      // Show whatever this spec last rendered, so opening a demo from the
      // gallery isn't a blank panel until you record it again.
      const prior = await getJSON<{ outputs: { path: string }[] }>(
        `/api/outputs?path=${encodeURIComponent(p)}`,
      ).catch(() => ({ outputs: [] }));
      if (prior.outputs.length) {
        setOutputs(prior.outputs.map((o) => o.path));
        setStale(true);
      }
    },
    [hydrate],
  );

  useEffect(() => {
    getJSON<{ specs: string[] }>("/api/specs").then((d) => setSpecs(d.specs)).catch(() => {});
    const p = new URLSearchParams(window.location.search).get("path");
    if (p) loadSpec(p);
  }, [loadSpec]);

  const save = useCallback(async () => {
    if (!path) return false;
    const r = await postJSON<{ ok: boolean; error?: string; warnings?: string[] }>("/api/spec", {
      path,
      raw,
    });
    if (r.error) {
      setWarnings([r.error]);
      return false;
    }
    setWarnings(r.warnings ?? []);
    setNote("Saved.");
    setDirty(false);
    // Re-read so the outline and chips reflect what was just written.
    const fresh = await getJSON<{ summary?: SpecSummary }>(
      `/api/spec?path=${encodeURIComponent(path)}`,
    ).catch(() => ({ summary: undefined }));
    hydrate(fresh.summary ?? null);
    return true;
  }, [path, raw, hydrate]);

  // ⌘S / Ctrl+S saves, the way every editor behaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  async function applyOptions() {
    const patch: any = { output: { preset }, polish: { frame, speed }, retries };
    patch.deterministic = { timeline };
    patch.output.subtitles = subtitles ? true : null;
    // Name the interactive build after the spec, so it lands beside the video.
    const base = path.split("/").pop()?.replace(/\.reel\.ya?ml$/i, "") || "demo";
    patch.output.html = interactive ? summary?.options.html ?? `out/${base}.html` : null;
    patch.output.languages = languages.trim()
      ? languages.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    patch.output.targetDuration = targetDuration.trim() || null;
    const r = await postJSON<{ raw: string }>("/api/patch", { raw, patch });
    setRaw(r.raw);
    setDirty(true);
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
    if (kind === "check") {
      setNote(
        summary?.branchCount
          ? "✓ Drift check passed — every step, on every branch path."
          : "✓ Drift check passed — every step still works.",
      );
    }
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

  const lineCount = Math.max(raw.split("\n").length, 1);

  return (
    <div>
      <PageHead
        eyebrow="Studio"
        title="Edit, render, and preview"
        sub="Tune the spec and output, then record — or verify and self-heal it against the live app."
      />

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
              <button
                className="btn btn-sm"
                onClick={() => getJSON<{ specs: string[] }>("/api/specs").then((d) => setSpecs(d.specs))}
                title="Refresh spec list"
              >
                ↻
              </button>
            </div>

            {summary && (
              <div className="mb-3">
                <SpecChips summary={summary} />
              </div>
            )}

            {/* The outline is the fastest way to read a spec's shape, so it sits
                beside the YAML rather than below it. */}
            <div className="mb-3 inline-flex rounded-xl border border-line bg-bg2 p-1">
              {(["yaml", "steps"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                    tab === t ? "bg-brand text-[#0a0d13]" : "text-muted hover:text-ink"
                  }`}
                >
                  {t === "yaml" ? "YAML" : `Steps${summary?.valid ? ` · ${summary.stepCount}` : ""}`}
                </button>
              ))}
            </div>

            {tab === "steps" ? (
              <div className="rounded-xl border border-line bg-bg2 p-3">
                <p className="mb-2 text-xs text-faint">
                  The shape of the demo. A branch shows both paths — only the one marked
                  <span className="mx-1 text-brand">in video</span> reaches the GIF.
                </p>
                <SpecOutline summary={summary} />
              </div>
            ) : (
            /* Line numbers make a YAML error message ("steps.3.click") findable. */
            <div className="flex overflow-hidden rounded-xl border border-line bg-bg2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
              <pre
                aria-hidden
                className="select-none border-r border-line px-2.5 py-2.5 text-right font-mono text-[12.5px] leading-relaxed text-faint"
              >
                {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
              </pre>
              <textarea
                ref={editor}
                className="min-h-[320px] flex-1 resize-y bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={(e) => {
                  // Tab indents instead of leaving the editor — YAML is indented.
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const el = e.currentTarget;
                    const { selectionStart: a, selectionEnd: b } = el;
                    const next = `${raw.slice(0, a)}  ${raw.slice(b)}`;
                    setRaw(next);
                    setDirty(true);
                    requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
                  }
                }}
                spellCheck={false}
                placeholder="Select a spec to edit its YAML…"
              />
            </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button className="btn btn-primary btn-sm" onClick={save} disabled={!path}>
                Save
              </button>
              <kbd className="rounded border border-line bg-elev px-1.5 py-0.5 font-mono text-[11px] text-faint">
                ⌘S
              </kbd>
              {dirty && <span className="tag !border-warn/40 !text-warn">unsaved</span>}
              {summary && !summary.valid && path && (
                <button
                  className="tag !border-warn/40 !text-warn"
                  onClick={() => setTab("steps")}
                  title="See what's wrong"
                >
                  {summary.errors.length} error{summary.errors.length > 1 ? "s" : ""}
                </button>
              )}
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
            <h2 className="mb-4 text-base font-semibold">Output &amp; polish</h2>
            <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
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
              <label className="block">
                <span className="label">Speed</span>
                <select
                  className="input"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}×{s === 1 ? " (as authored)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Fit to duration</span>
                <input
                  className="input"
                  value={targetDuration}
                  onChange={(e) => setTargetDuration(e.target.value)}
                  placeholder="30s — leave blank for natural"
                />
              </label>
            </div>

            <div className="mt-4 rounded-xl border border-line bg-bg2 p-3.5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Reproducible timeline</div>
                  <div className="text-xs text-faint">
                    Renders byte-identical media on any machine, so committed demo media only
                    changes when the demo does. Turn off to film the app&apos;s own animation in
                    real time.
                  </div>
                </div>
                <Toggle checked={timeline} onChange={setTimeline} />
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-line bg-bg2 p-3.5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Interactive HTML</div>
                  <div className="text-xs text-faint">
                    A self-contained click-through with hotspots and deep links — one file, no
                    hosting.{" "}
                    {summary?.branchCount
                      ? "This spec branches, so it's the only output that carries every path."
                      : ""}
                  </div>
                </div>
                <Toggle checked={interactive} onChange={setInteractive} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
              <Toggle checked={subtitles} onChange={setSubtitles} label="Subtitles (SRT/VTT)" />
              <label className="flex items-center gap-2">
                <span className="label mb-0">Localize</span>
                <input
                  className="input !w-40 !py-1.5"
                  value={languages}
                  onChange={(e) => setLanguages(e.target.value)}
                  placeholder="es, fr"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="label mb-0" title="Retry a step that fails transiently">
                  Retries
                </span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  className="input !w-20 !py-1.5"
                  value={retries}
                  onChange={(e) => setRetries(Number(e.target.value))}
                />
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
              <button
                className="btn btn-primary"
                onClick={() => job("record")}
                disabled={!path || !!running}
                title={
                  summary && summary.variants > 1
                    ? `Renders ${summary.variants} variants`
                    : "Drive the app and render the demo"
                }
              >
                {running === "record" ? <Spinner /> : "●"} Record
              </button>
              <button
                className="btn"
                onClick={() => job("check")}
                disabled={!path || !!running}
                title="Re-run headlessly and fail if any step can't complete"
              >
                {running === "check" ? <Spinner /> : "✓"} Check drift
              </button>
              <button
                className="btn"
                onClick={() => job("heal", { write: true })}
                disabled={!path || !!running}
                title="Repair broken selectors — works offline, no model required"
              >
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
