"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { EmptyState, PageHead, Spinner, Toggle } from "@/components/bits";
import { LogConsole } from "@/components/LogConsole";
import { MediaPreview } from "@/components/MediaPreview";
import { SpecChips, SpecOutline } from "@/components/SpecOutline";
import { ScriptPanel } from "@/components/ScriptPanel";
import {
  getJSON,
  postJSON,
  runJob,
  type LogLine,
  type OutlineStep,
  type Script,
  type SpecSummary,
} from "@/lib/api";

const PRESETS = ["share", "readme", "social", "hq", "docs"];
const FRAMES = ["none", "browser", "window"];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/* Mirrors THEME_NAMES in src/terminal/themes.ts — test/themes.test.ts fails if
   the two drift, so a new scheme can't be added to one and not the other. */
const TERMINAL_THEMES = [
  "reel",
  "dracula",
  "nord",
  "catppuccin-mocha",
  "tokyo-night",
  "gruvbox-dark",
  "one-dark",
  "solarized-dark",
  "solarized-light",
  "github-light",
];

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
  const [zoomOutput, setZoomOutput] = useState(false);
  const [zoomRows, setZoomRows] = useState(12);
  const [terminalTheme, setTerminalTheme] = useState("reel");
  // audio
  const [narration, setNarration] = useState(false);
  const [voiceProvider, setVoiceProvider] = useState("elevenlabs");
  const [voiceId, setVoiceId] = useState("");
  const [audioFit, setAudioFit] = useState("stretch");
  const [sfx, setSfx] = useState("none");
  const [music, setMusic] = useState("");
  const [musicDuck, setMusicDuck] = useState(-14);

  // job
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  /** Whether the last note was a success or a failure — they read very differently. */
  const [noteTone, setNoteTone] = useState<"ok" | "err">("ok");
  /** True when the preview is a previous render rather than this session's. */
  const [stale, setStale] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  /* Output settings live beside the spec rather than below it: stacked, they
     doubled the page height for controls you touch once per demo. */
  const [tab, setTab] = useState<"yaml" | "steps" | "script" | "output">("yaml");
  const [script, setScript] = useState<Script | null>(null);

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
    setZoomOutput(s.options.zoomOutput);
    setZoomRows(s.options.zoomRows);
    setTerminalTheme(s.options.terminalTheme ?? "reel");
    setNarration(s.options.audio.enabled);
    setVoiceProvider(s.options.audio.provider);
    setVoiceId(s.options.audio.voiceId ?? "");
    setAudioFit(s.options.audio.fit);
    setSfx(s.options.audio.sfx);
    setMusic(s.options.audio.music ?? "");
    setMusicDuck(s.options.audio.musicDuck ?? -14);
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
      // Read from the same spec, and cheap: no browser, no network, no render.
      postJSON<Script>("/api/script", { path: p })
        .then(setScript)
        .catch(() => setScript(null));
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
    // Belt to the server's braces. Every job saves first, so pressing Record
    // before the spec has finished loading would post an empty buffer — and
    // the file on disk is the only copy anyone has.
    if (!raw.trim()) {
      setNoteTone("err");
      setNote("Still loading this spec — nothing was saved.");
      return false;
    }
    const r = await postJSON<{ ok: boolean; error?: string; warnings?: string[] }>("/api/spec", {
      path,
      raw,
    });
    if (r.error) {
      setWarnings([r.error]);
      return false;
    }
    setWarnings(r.warnings ?? []);
    setNoteTone("ok");
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
    // Camera-follow is terminal-only; writing it into a web spec would add a
    // key that does nothing there.
    if (summary?.kind === "terminal") {
      // null removes the key, so switching it off leaves the spec as clean as
      // it was before anyone touched the toggle.
      patch.polish.zoomOutput = zoomOutput ? true : null;
      patch.polish.zoomRows = zoomOutput ? zoomRows : null;
      patch.terminal = { theme: terminalTheme };
    }
    patch.output.subtitles = subtitles ? true : null;
    // Name the interactive build after the spec, so it lands beside the video.
    const base = path.split("/").pop()?.replace(/\.reel\.ya?ml$/i, "") || "demo";
    patch.output.html = interactive ? summary?.options.html ?? `out/${base}.html` : null;
    patch.output.languages = languages.trim()
      ? languages.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
    patch.output.targetDuration = targetDuration.trim() || null;

    // Audio. Switching narration off removes the whole block rather than
    // leaving a configured-but-inert one behind, so the spec reads the way it
    // behaves. `output.audio` stays implicit: the block's presence is the
    // switch, and a second one would be a second source of truth.
    if (narration) {
      patch.audio = {
        voice: { provider: voiceProvider, id: voiceId.trim() || null },
        fit: audioFit,
        sfx,
        music: music.trim() ? { file: music.trim(), duck: musicDuck } : null,
      };
    } else {
      patch.audio = null;
    }
    const r = await postJSON<{ raw: string }>("/api/patch", { raw, patch });
    setRaw(r.raw);
    setDirty(true);
    setNoteTone("ok");
    setNote("Options applied — review and Save.");
  }

  /**
   * Flip a run step between filmed and off-camera.
   *
   * Goes through its own endpoint rather than the options patch: the step may be
   * written as a bare string, and merging a flag into a string would drop the
   * command. The server normalises the form before setting the flag.
   */
  async function toggleHidden(step: OutlineStep) {
    try {
      const r = await postJSON<{ raw: string; summary: SpecSummary }>("/api/step-hidden", {
        raw,
        index: step.index - 1, // the outline is 1-based, the step list is not
        hidden: !step.hidden,
      });
      setRaw(r.raw);
      // Refresh the outline only — hydrate() would also reset the options form,
      // discarding anything typed there but not yet applied.
      setSummary(r.summary);
      setDirty(true);
      setNoteTone("ok");
      setNote(
        step.hidden
          ? "Step will be filmed again — review and Save."
          : "Step will run off camera — review and Save.",
      );
    } catch (err) {
      setNoteTone("err");
      setNote((err as Error).message);
    }
  }

  async function job(
    kind: "record" | "check" | "heal",
    extra: Record<string, unknown> = {},
    id: string = kind,
  ) {
    if (!(await save())) return;
    setRunning(id);
    setLogs([]);
    // Only a record replaces the media, so only a record clears the preview.
    // Check and heal render nothing at all — blanking the panel for them threw
    // away a perfectly good previous render and told the user "nothing rendered
    // yet" about a demo sitting finished on disk. Heal may edit the spec, which
    // makes the render stale rather than absent; `stale` already says so.
    if (kind === "record") setOutputs([]);
    setNote(null);
    const done = await runJob(`/api/${kind}`, { path, ...extra }, (l) => setLogs((p) => [...p, l]));
    setRunning(null);
    if (!done.ok) {
      setNoteTone("err");
      setNote(done.hint ? `${done.error} — ${done.hint}` : done.error ?? "failed");
      return;
    }
    if (kind === "record") {
      setOutputs(done.result?.outputs ?? []);
      // A preview does not replace the master and deliberately writes no
      // fingerprint stamp, so it cannot make the real render current.
      if (!extra.draft) setStale(false);
    }
    if (kind === "check") {
      setNoteTone("ok");
      setNote(
        summary?.branchCount
          ? "✓ Drift check passed — every step, on every branch path."
          : "✓ Drift check passed — every step still works.",
      );
    }
    if (kind === "heal") {
      const fixes = done.result?.fixes ?? [];
      const unresolved = done.result?.unresolved ?? [];
      setNoteTone(unresolved.length ? "err" : "ok");
      setNote(
        fixes.length || unresolved.length
          ? `${fixes.length} repaired, ${unresolved.length} unresolved.`
          : "No drift — every step works.",
      );
      if (fixes.length) loadSpec(path); // reload the rewritten spec
    }
  }


  const lineCount = Math.max(raw.split("\n").length, 1);
  const busy = !!running;
  const invalid = Boolean(summary && !summary.valid && path);

  /* The jobs share a shape, so describe them once rather than repeating the
     button markup with slightly different titles. `id` rather than `kind` as
     the key: a preview is a record too, and two buttons running the same verb
     with different flags must still be told apart. */
  const ACTIONS = [
    {
      id: "record",
      kind: "record" as const,
      label: "Record",
      title:
        summary && summary.variants > 1
          ? `Drive the app and render ${summary.variants} variants`
          : "Drive the app and render the demo",
      primary: true,
      extra: {},
    },
    {
      id: "preview",
      kind: "record" as const,
      label: "Preview",
      title:
        "Quick draft: small, low frame rate, video only, and only narration already in the cache",
      primary: false,
      extra: { draft: true },
    },
    {
      id: "check",
      kind: "check" as const,
      label: "Check drift",
      title: "Re-run headlessly and fail if any step can't complete",
      primary: false,
      extra: {},
    },
    {
      id: "heal",
      kind: "heal" as const,
      label: "Heal",
      title: "Repair broken selectors — works offline, no model required",
      primary: false,
      extra: { write: true },
    },
  ];

  return (
    <div>
      <PageHead
        eyebrow="Studio"
        title="Edit, render, and preview"
        sub="Tune the spec and its output, then record — or verify and self-heal it against the live app."
      />

      {/* ---- toolbar ------------------------------------------------------
          Spec choice and the three jobs are what this page is for, so they
          stay pinned instead of scrolling away behind a long YAML file. */}
      <div className="sticky top-0 z-30 -mx-2 mb-5 rounded-2xl border border-line bg-bg/80 px-4 py-3 backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="input !w-auto min-w-[260px] flex-1 font-mono text-[13px]"
            value={path}
            onChange={(e) => loadSpec(e.target.value)}
          >
            <option value="">Select a spec…</option>
            {specs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() =>
              getJSON<{ specs: string[] }>("/api/specs").then((d) => setSpecs(d.specs))
            }
            title="Refresh the spec list"
          >
            ↻
          </button>

          <div className="flex items-center gap-2 max-[720px]:w-full">
            <button className="btn btn-sm" onClick={save} disabled={!path}>
              Save
            </button>
            <kbd className="kbd">⌘S</kbd>
            {dirty && <span className="tag !border-warn/40 !text-warn">unsaved</span>}
          </div>

          <div className="ml-auto flex flex-wrap gap-2 max-[720px]:ml-0 max-[720px]:w-full">
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                className={`btn btn-sm ${a.primary ? "btn-brand" : ""}`}
                onClick={() => job(a.kind, a.extra, a.id)}
                disabled={!path || busy}
                title={a.title}
              >
                {running === a.id && <Spinner />}
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {note && (
          <div
            className={`mt-2.5 rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${
              noteTone === "err"
                ? "border-err/30 bg-err/[0.07] text-err"
                : "border-ok/25 bg-ok/[0.07] text-ok"
            }`}
          >
            {note}
          </div>
        )}
      </div>

      {!path ? (
        <EmptyState
          icon="M4 5h16v14H4zM4 10h16"
          title="No spec open"
          sub="Pick one above to edit and render it, or describe a new demo in plain English and let an agent write the spec for you."
        >
          <Link href="/author" className="btn btn-brand">
            Author a demo
          </Link>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] gap-5 max-[1100px]:grid-cols-1">
          {/* ---- left: the spec ---- */}
          <div className="flex flex-col gap-5">
            <div className="card">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-xl border border-line bg-bg2 p-1">
                  {(["yaml", "steps", "script", "output"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                        tab === t ? "bg-brand text-[#0a0d13]" : "text-muted hover:text-ink"
                      }`}
                    >
                      {t === "yaml"
                        ? "YAML"
                        : t === "steps"
                          ? `Steps${summary?.valid ? ` · ${summary.stepCount}` : ""}`
                          : t === "script"
                            ? `Script${script ? ` · ${script.lines.length}` : ""}`
                            : "Output & polish"}
                    </button>
                  ))}
                </div>
                {tab === "output" ? (
                  <button className="btn btn-sm btn-ghost" onClick={applyOptions} disabled={!path}>
                    Apply to spec
                  </button>
                ) : (
                  summary && <SpecChips summary={summary} />
                )}
              </div>

              {invalid && (
                <button
                  onClick={() => setTab("steps")}
                  className="mb-3 flex w-full items-center gap-2 rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-left text-[13px] text-err"
                >
                  {summary!.errors.length} error{summary!.errors.length > 1 ? "s" : ""} in this spec
                  — see what&apos;s wrong →
                </button>
              )}

              {tab === "script" ? (
                <div className="max-h-[720px] overflow-y-auto rounded-xl border border-line bg-bg2 p-3 pr-2">
                  <ScriptPanel
                    path={path}
                    script={script}
                    busy={busy}
                    onLog={(l) => setLogs((p) => [...p, l])}
                    onBusy={setRunning}
                    onReload={() => loadSpec(path)}
                  />
                </div>
              ) : tab === "steps" ? (
                <div className="rounded-xl border border-line bg-bg2 p-3">
                  <p className="mb-2 text-xs leading-relaxed text-faint">
                    The shape of the demo. A branch shows both paths — only the one marked
                    <span className="mx-1 text-brand">in video</span> reaches the GIF.
                  </p>
                  <SpecOutline summary={summary} onToggleHidden={toggleHidden} />
                </div>
              ) : tab === "output" ? (
                <div className="max-h-[720px] space-y-4 overflow-y-auto pr-1">
                  <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
                    <label className="block">
                      <span className="label">Preset</span>
                      <select
                        className="input"
                        value={preset}
                        onChange={(e) => setPreset(e.target.value)}
                      >
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
                        placeholder="30s — blank for natural"
                      />
                    </label>
                  </div>

                  {summary?.kind === "terminal" && (
                    <div className="rounded-xl border border-line bg-bg2 p-3.5">
                      <label className="mb-3 block border-b border-line pb-3">
                        <span className="label">Terminal theme</span>
                        <select
                          className="input"
                          value={terminalTheme}
                          onChange={(e) => setTerminalTheme(e.target.value)}
                        >
                          {TERMINAL_THEMES.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                        <span className="mt-1.5 block text-xs leading-relaxed text-faint">
                          The 16 ANSI colours plus a matching background. Changing it re-shoots the
                          demo — its rendered media will change.
                        </span>
                      </label>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-medium">Camera follows output</div>
                          <div className="text-xs leading-relaxed text-faint">
                            After each command, ease the shot onto what it printed. Off by default, so
                            turning it on re-shoots this demo — its rendered media will change.
                          </div>
                        </div>
                        <Toggle checked={zoomOutput} onChange={setZoomOutput} />
                      </div>
                      {zoomOutput && (
                        <label className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                          <span className="label mb-0" title="Taller output is framed at its tail">
                            Longest shot
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={120}
                            className="input !w-20 !py-1.5"
                            value={zoomRows}
                            onChange={(e) => setZoomRows(Number(e.target.value))}
                          />
                          <span className="text-xs text-faint">rows</span>
                        </label>
                      )}
                    </div>
                  )}

                  <div className="mt-4 rounded-xl border border-line bg-bg2 p-3.5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">Reproducible timeline</div>
                        <div className="text-xs leading-relaxed text-faint">
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
                        <div className="text-xs leading-relaxed text-faint">
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

                  <div className="mt-3 rounded-xl border border-line bg-bg2 p-3.5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">Narration</div>
                        <div className="text-xs leading-relaxed text-faint">
                          Speaks the <code>say:</code> line beside each caption, and stretches the
                          timeline so the picture waits for the voice.{" "}
                          {narration && summary
                            ? summary.options.audio.spokenLines
                              ? `${summary.options.audio.spokenLines} steps carry a line.`
                              : "No step carries a line yet, so this would render silent."
                            : ""}
                        </div>
                      </div>
                      <Toggle checked={narration} onChange={setNarration} />
                    </div>

                    {narration && (
                      <div className="mt-3 space-y-3 border-t border-line pt-3">
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                          <label className="flex items-center gap-2">
                            <span className="label mb-0">Voice</span>
                            <select
                              className="input !w-32 !py-1.5"
                              value={voiceProvider}
                              onChange={(e) => setVoiceProvider(e.target.value)}
                            >
                              <option value="elevenlabs">ElevenLabs</option>
                              <option value="openai">OpenAI</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2">
                            <span
                              className="label mb-0"
                              title="Pin the voice: it is part of the cache key, so naming it keeps renders reproducible"
                            >
                              Voice id
                            </span>
                            <input
                              className="input !w-52 !py-1.5"
                              value={voiceId}
                              onChange={(e) => setVoiceId(e.target.value)}
                              placeholder="provider default"
                            />
                          </label>
                          <label className="flex items-center gap-2">
                            <span
                              className="label mb-0"
                              title="Speech usually runs longer than the caption it belongs to"
                            >
                              Fit
                            </span>
                            <select
                              className="input !w-40 !py-1.5"
                              value={audioFit}
                              onChange={(e) => setAudioFit(e.target.value)}
                            >
                              <option value="stretch">Stretch to fit</option>
                              <option value="none">Keep timings</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2">
                            <span className="label mb-0" title="Clicks, key texture, card sweeps">
                              Effects
                            </span>
                            <select
                              className="input !w-28 !py-1.5"
                              value={sfx}
                              onChange={(e) => setSfx(e.target.value)}
                            >
                              <option value="none">None</option>
                              <option value="subtle">Subtle</option>
                              <option value="full">Full</option>
                            </select>
                          </label>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                          <label className="flex items-center gap-2">
                            <span className="label mb-0" title="A file you have the rights to — Reel ships none">
                              Music bed
                            </span>
                            <input
                              className="input !w-52 !py-1.5"
                              value={music}
                              onChange={(e) => setMusic(e.target.value)}
                              placeholder="bed.mp3"
                            />
                          </label>
                          {music.trim() && (
                            <label className="flex items-center gap-2">
                              <span className="label mb-0" title="Honoured exactly, in decibels">
                                Duck
                              </span>
                              <input
                                type="number"
                                max={0}
                                min={-40}
                                className="input !w-20 !py-1.5"
                                value={musicDuck}
                                onChange={(e) => setMusicDuck(Number(e.target.value))}
                              />
                              <span className="text-xs text-faint">dB under the voice</span>
                            </label>
                          )}
                        </div>

                        <div className="text-xs leading-relaxed text-faint">
                          A key is needed only to speak a line that changed — after that the audio
                          lives in <code>.reel-cache/voice</code>, which is meant to be committed so
                          the demo renders the same bytes anywhere, with no key at all.
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                    <Toggle checked={subtitles} onChange={setSubtitles} label="Subtitles (SRT/VTT)" />
                    <label className="flex items-center gap-2">
                      <span
                        className="label mb-0"
                        title={
                          narration
                            ? "Subtitle variants, and a spoken track per language from the same recording"
                            : "Localized subtitle variants"
                        }
                      >
                        Localize
                      </span>
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
                </div>
              ) : (
                /* Line numbers make a YAML error ("steps.3.click") findable. */
                <div className="flex overflow-hidden rounded-xl border border-line bg-bg2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                  <pre
                    aria-hidden
                    className="select-none border-r border-line px-2.5 py-2.5 text-right font-mono text-[12.5px] leading-relaxed text-faint"
                  >
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                  </pre>
                  <textarea
                    ref={editor}
                    className="min-h-[520px] flex-1 resize-y bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
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

              {warnings.length > 0 && (
                <ul className="mt-3 space-y-1 rounded-lg border border-warn/25 bg-warn/[0.06] p-3 text-[12.5px] text-warn">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>

          </div>

          {/* ---- right: the result ----
              Preview above the log: the render is the point, and the log is
              only interesting while it is still running or when it failed. */}
          <div className="flex flex-col gap-5 max-[1100px]:contents">
            <div className="card lg:sticky lg:top-[92px]">
              <div className="mb-3 flex items-center gap-2.5">
                <h2 className="text-[15px] font-semibold">Preview</h2>
                {stale && (
                  <span className="tag" title="Rendered by an earlier run — record to refresh">
                    last render
                  </span>
                )}
              </div>
              {outputs.length > 0 ? (
                <MediaPreview outputs={outputs} />
              ) : (
                <EmptyState
                  icon="M5 3l14 9-14 9z"
                  title={busy ? "Rendering…" : "Nothing rendered yet"}
                  sub={
                    busy
                      ? "The finished media will appear here."
                      : "Hit Record to drive the app and render this spec. The GIF, video and storyboard land here."
                  }
                />
              )}
            </div>

            <div className="card">
              <h2 className="mb-3 text-[15px] font-semibold">Run log</h2>
              <LogConsole lines={logs} running={busy} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
