"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Banner,
  Check,
  EmptyState,
  PageHead,
  Spinner,
  TabPanel,
  Tabs,
  Toggle,
  type TabDef,
} from "@/components/bits";
import { DoctorCard } from "@/components/DoctorCard";
import { LogConsole } from "@/components/LogConsole";
import { MediaPreview } from "@/components/MediaPreview";
import { SpecChips, SpecOutline } from "@/components/SpecOutline";
import { ScriptPanel } from "@/components/ScriptPanel";
import { BeatStrip, type Beat } from "@/components/BeatStrip";
import { MediaLibrary } from "@/components/MediaLibrary";
import {
  getJSON,
  postJSON,
  runJob,
  type ConfigInfo,
  type LogLine,
  type OutlineStep,
  type Script,
  type SpecSummary,
} from "@/lib/api";

const PRESETS = ["share", "readme", "social", "hq", "docs"];
const FRAMES = ["none", "browser", "window"];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * The output formats a spec can render, and what each one is for.
 *
 * Reel's headline claim is "one spec, every format", and until now the only
 * way to choose them in Studio was to type the paths into the YAML by hand.
 */
const FORMATS = [
  { key: "gif", label: "GIF", hint: "Loops in a README or a chat thread.", ext: "gif" },
  { key: "mp4", label: "MP4", hint: "The one to embed in docs or post.", ext: "mp4" },
  { key: "webm", label: "WebM", hint: "Smaller, for the web; no Safari before 16.", ext: "webm" },
  {
    key: "storyboard",
    label: "Storyboard",
    hint: "A directory of stills, one per beat.",
    ext: "",
  },
] as const;

/**
 * How `fit` reconciles a timeline written for reading with a voice that takes
 * longer to say it. Worded as choices rather than as enum values, and `flow` is
 * first because it is the schema's default.
 */
const FITS = [
  { value: "flow", label: "Flow (default)", title: "Absorb the overrun into the nearby holds — the least frozen picture" },
  { value: "stretch", label: "Stretch to fit", title: "Extend each hold so the picture waits for the whole line" },
  { value: "none", label: "Keep timings", title: "Leave the timeline alone; a long line will run past its shot" },
];

/** Everything the Output & polish tab edits, in one object so it can be diffed. */
interface OptionsForm {
  preset: string;
  frame: string;
  subtitles: boolean;
  interactive: boolean;
  languages: string;
  speed: number;
  targetDuration: string;
  retries: number;
  timeline: boolean;
  zoomOutput: boolean;
  zoomRows: number;
  terminalTheme: string;
  gif: boolean;
  mp4: boolean;
  webm: boolean;
  storyboard: boolean;
  narration: boolean;
  voiceProvider: string;
  voiceId: string;
  audioFit: string;
  sfx: string;
  music: string;
  musicDuck: number;
}

const BLANK_FORM: OptionsForm = {
  preset: "share",
  frame: "none",
  subtitles: false,
  interactive: false,
  languages: "",
  speed: 1,
  targetDuration: "",
  retries: 0,
  timeline: true,
  zoomOutput: false,
  zoomRows: 12,
  terminalTheme: "reel",
  gif: false,
  mp4: false,
  webm: false,
  storyboard: false,
  narration: false,
  voiceProvider: "elevenlabs",
  voiceId: "",
  audioFit: "flow",
  sfx: "none",
  music: "",
  musicDuck: -14,
};

/** The form the spec describes. Pure, so it can also produce the sync baseline. */
function formOf(s: SpecSummary | null): OptionsForm {
  if (!s?.valid) return BLANK_FORM;
  const o = s.options;
  return {
    preset: o.preset,
    frame: o.frame,
    subtitles: o.subtitles,
    interactive: Boolean(o.html),
    languages: o.languages.join(", "),
    speed: o.speed,
    targetDuration: o.targetDuration ?? "",
    retries: o.retries,
    timeline: o.timeline,
    zoomOutput: o.zoomOutput,
    zoomRows: o.zoomRows,
    terminalTheme: o.terminalTheme ?? "reel",
    gif: Boolean(o.gif),
    mp4: Boolean(o.mp4),
    webm: Boolean(o.webm),
    storyboard: Boolean(o.storyboard),
    narration: o.audio.enabled,
    voiceProvider: o.audio.provider,
    voiceId: o.audio.voiceId ?? "",
    audioFit: o.audio.fit,
    sfx: o.audio.sfx,
    music: o.audio.music ?? "",
    musicDuck: o.audio.musicDuck ?? -14,
  };
}

/** The YAML patch that makes the spec say what the form says. */
function patchOf(form: OptionsForm, summary: SpecSummary | null, path: string): Record<string, any> {
  // Name anything new after the spec, so it lands beside whatever it already
  // renders rather than in some unrelated `out/demo.*`.
  const base = path.split("/").pop()?.replace(/\.reel\.ya?ml$/i, "") || "demo";
  const patch: any = {
    output: { preset: form.preset },
    polish: { frame: form.frame, speed: form.speed },
    retries: form.retries,
    deterministic: { timeline: form.timeline },
  };

  // Camera-follow is terminal-only; writing it into a web spec would add a key
  // that does nothing there.
  if (summary?.kind === "terminal") {
    // null removes the key, so switching it off leaves the spec as clean as it
    // was before anyone touched the toggle.
    patch.polish.zoomOutput = form.zoomOutput ? true : null;
    patch.polish.zoomRows = form.zoomOutput ? form.zoomRows : null;
    patch.terminal = { theme: form.terminalTheme };
  }

  // Formats. An existing path is kept rather than renamed — someone who chose
  // `docs/demo.gif` did so on purpose and a checkbox must not move their file.
  for (const f of FORMATS) {
    const current = summary?.options[f.key];
    patch.output[f.key] = form[f.key]
      ? (current ?? (f.ext ? `out/${base}.${f.ext}` : "out/storyboard"))
      : null;
  }

  patch.output.subtitles = form.subtitles ? true : null;
  patch.output.html = form.interactive ? (summary?.options.html ?? `out/${base}.html`) : null;
  patch.output.languages = form.languages.trim()
    ? form.languages.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  patch.output.targetDuration = form.targetDuration.trim() || null;

  // Audio. Switching narration off removes the whole block rather than leaving
  // a configured-but-inert one behind, so the spec reads the way it behaves.
  // `output.audio` stays implicit: the block's presence is the switch, and a
  // second one would be a second source of truth.
  patch.audio = form.narration
    ? {
        voice: { provider: form.voiceProvider, id: form.voiceId.trim() || null },
        fit: form.audioFit,
        sfx: form.sfx,
        music: form.music.trim() ? { file: form.music.trim(), duck: form.musicDuck } : null,
      }
    : null;
  return patch;
}

type Tab = "yaml" | "steps" | "beats" | "script" | "output";

/** How long to wait after the last keystroke before rewriting the YAML. */
const SYNC_MS = 400;

export default function StudioPage() {
  const [specs, setSpecs] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [raw, setRaw] = useState("");
  const [summary, setSummary] = useState<SpecSummary | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);

  /* The output-options form, hydrated from the spec rather than from defaults,
     and written straight back into the YAML as it changes. It used to be React
     state and nothing else: turning narration on and pressing Record saved the
     untouched buffer and rendered a silent demo without a word of warning. */
  const [form, setForm] = useState<OptionsForm>(BLANK_FORM);
  /** The form as the current YAML describes it — anything else is unsynced. */
  const syncedRef = useRef<string>(JSON.stringify(BLANK_FORM));
  /** Which side made the last edit, so the two never chase each other. */
  const editedBy = useRef<"form" | "yaml" | "load">("load");
  const rawRef = useRef("");
  const [syncing, setSyncing] = useState(false);

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
  const [tab, setTab] = useState<Tab>("yaml");
  const [script, setScript] = useState<Script | null>(null);
  const [beats, setBeats] = useState<{ beats: Beat[]; durationMs: number; rendered: boolean }>({
    beats: [],
    durationMs: 0,
    rendered: false,
  });

  useEffect(() => {
    rawRef.current = raw;
  }, [raw]);

  /** Fill the form from what the spec says, and mark that as the synced state. */
  const hydrate = useCallback((s: SpecSummary | null) => {
    setSummary(s);
    const next = formOf(s);
    setForm(next);
    syncedRef.current = JSON.stringify(next);
  }, []);

  const loadSpec = useCallback(
    async (p: string) => {
      editedBy.current = "load";
      setPath(p);
      setOutputs([]);
      setNote(null);
      setStale(false);
      setDirty(false);
      if (!p) {
        setRaw("");
        hydrate(null);
        return;
      }
      const r = await getJSON<{ raw?: string; summary?: SpecSummary }>(
        `/api/spec?path=${encodeURIComponent(p)}`,
      ).catch(() => ({ raw: "", summary: undefined }));
      setRaw(r.raw ?? "");
      rawRef.current = r.raw ?? "";
      hydrate(r.summary ?? null);
      // Read from the same spec, and cheap: no browser, no network, no render.
      postJSON<Script>("/api/script", { path: p })
        .then(setScript)
        .catch(() => setScript(null));
      // Beat times come from the last render's stamp, so this costs a file read
      // rather than a recording.
      postJSON<{ beats: Beat[]; durationMs: number; rendered: boolean }>("/api/beats", { path: p })
        .then(setBeats)
        .catch(() => setBeats({ beats: [], durationMs: 0, rendered: false }));
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
    getJSON<ConfigInfo>("/api/config").then(setCfg).catch(() => {});
    const p = new URLSearchParams(window.location.search).get("path");
    if (p) loadSpec(p);
  }, [loadSpec]);

  /* ---- keeping the form and the YAML the same document ------------------
     Two debounced effects, one per direction, each disarmed while the other
     is the source of the change. Without that they would ping-pong: a patch
     rewrites the YAML, the YAML re-derives the form, the form patches again. */

  /**
   * Write the form into the YAML now, rather than when the debounce expires.
   *
   * The debounce is a courtesy to the server, not a licence to lose an edit:
   * pressing Record 200ms after flipping a toggle has to render what the toggle
   * says. Every job saves through `save()`, and `save()` flushes first, so
   * there is no window in which the buffer disagrees with the controls.
   *
   * A no-op unless the form is the side that changed — flushing on top of a
   * hand-edited buffer would write stale form values over it.
   */
  const flush = useCallback(async () => {
    if (!path || editedBy.current !== "form") return;
    const sig = JSON.stringify(form);
    if (sig === syncedRef.current) return;
    const r = await postJSON<{ raw: string }>("/api/patch", {
      raw: rawRef.current,
      patch: patchOf(form, summary, path),
    }).catch(() => null);
    if (!r?.raw) return;
    if (r.raw !== rawRef.current) {
      rawRef.current = r.raw;
      setRaw(r.raw);
      setDirty(true);
      // Re-read the spec the patch just produced, so the chips, the step count
      // and the "this would render silent" warning describe the buffer rather
      // than the last save. The form is deliberately left alone — rehydrating
      // it would fight whatever is being typed.
      const fresh = await postJSON<{ summary: SpecSummary }>("/api/summary", { raw: r.raw })
        .catch(() => null);
      if (fresh?.summary) setSummary(fresh.summary);
    }
    syncedRef.current = sig;
  }, [form, path, summary]);

  // form → YAML
  useEffect(() => {
    if (!path || editedBy.current !== "form") return;
    // Already what the YAML says — including after an undo that lands back on
    // the saved value, which otherwise left the "writing…" note up forever.
    if (JSON.stringify(form) === syncedRef.current) {
      setSyncing(false);
      return;
    }
    setSyncing(true);
    const t = setTimeout(() => {
      void flush().finally(() => setSyncing(false));
    }, SYNC_MS);
    return () => clearTimeout(t);
  }, [form, path, flush]);

  // YAML → form. Hand-editing the buffer used to leave the form showing the
  // last saved values, so the next control touched wrote them back over the
  // edit. Re-deriving it from the buffer is what makes both surfaces safe.
  useEffect(() => {
    if (!path || editedBy.current !== "yaml") return;
    const t = setTimeout(async () => {
      const r = await postJSON<{ summary: SpecSummary }>("/api/summary", { raw: rawRef.current })
        .catch(() => null);
      // An unparseable buffer mid-keystroke is normal; keep the last good form
      // rather than blanking the whole tab on every half-typed line.
      if (r?.summary?.valid) hydrate(r.summary);
      else if (r?.summary) setSummary(r.summary);
    }, SYNC_MS);
    return () => clearTimeout(t);
  }, [raw, path, hydrate]);

  /** Change one field of the options form. */
  const set = useCallback(<K extends keyof OptionsForm>(key: K, value: OptionsForm[K]) => {
    editedBy.current = "form";
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    if (!path) return false;
    // Anything the form changed but the debounce hasn't written yet goes in
    // first. Without this, Record within 400ms of a toggle rendered the old
    // spec — which is the silent-narration bug with a shorter fuse.
    await flush();
    // Belt to the server's braces. Every job saves first, so pressing Record
    // before the spec has finished loading would post an empty buffer — and
    // the file on disk is the only copy anyone has.
    if (!rawRef.current.trim()) {
      setNoteTone("err");
      setNote("Still loading this spec — nothing was saved.");
      return false;
    }
    const r = await postJSON<{ ok: boolean; error?: string; warnings?: string[] }>("/api/spec", {
      path,
      raw: rawRef.current,
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
    editedBy.current = "load";
    hydrate(fresh.summary ?? null);
    return true;
  }, [path, hydrate, flush]);

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
        raw: rawRef.current,
        index: step.index - 1, // the outline is 1-based, the step list is not
        hidden: !step.hidden,
      });
      editedBy.current = "load";
      rawRef.current = r.raw;
      setRaw(r.raw);
      // Refresh the outline only — hydrating would also reset the options form,
      // discarding anything typed there but not yet written back.
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
  const themes = cfg?.terminalThemes ?? [];
  /**
   * A spec must render something — the schema rejects an output block with no
   * format at all — so the last one standing can't be cleared. `player` counts
   * even though it has no checkbox: a spec that renders one is already valid,
   * and locking a checkbox it doesn't need would be a lie.
   */
  const formatsOn =
    FORMATS.filter((f) => form[f.key]).length +
    (form.interactive ? 1 : 0) +
    (summary?.options.player ? 1 : 0);

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

  const TABS: TabDef<Tab>[] = useMemo(
    () => [
      { id: "yaml", label: "YAML" },
      { id: "steps", label: `Steps${summary?.valid ? ` · ${summary.stepCount}` : ""}` },
      { id: "beats", label: "Beats & media" },
      { id: "script", label: `Script${script ? ` · ${script.lines.length}` : ""}` },
      { id: "output", label: "Output & polish" },
    ],
    [summary?.valid, summary?.stepCount, script],
  );

  return (
    <div>
      <PageHead
        eyebrow="Studio"
        title="Edit, render, and preview"
        sub="Tune the spec and its output, then record — or verify and self-heal it against the live app."
        actions={
          <Link href="/new" className="btn btn-sm">
            New demo
          </Link>
        }
      />

      {/* Missing ffmpeg or a missing browser is the single most common
          first-run failure, and it used to surface as one red line at the
          bottom of a render that had already spent two minutes failing. */}
      <DoctorCard />

      {/* ---- toolbar ------------------------------------------------------
          Spec choice and the three jobs are what this page is for, so they
          stay pinned instead of scrolling away behind a long YAML file. */}
      <div className="sticky top-0 z-30 -mx-2 mb-5 rounded-2xl border border-line bg-bg/80 px-4 py-3 backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Spec to edit"
            className="input !w-auto min-w-0 flex-1 basis-[220px] font-mono text-[13px]"
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
            aria-label="Refresh the spec list"
            title="Refresh the spec list"
          >
            <span aria-hidden>↻</span>
          </button>

          <div className="flex items-center gap-2 max-sm:w-full">
            <button className="btn btn-sm" onClick={save} disabled={!path}>
              Save
            </button>
            <kbd className="kbd">⌘S</kbd>
            {dirty && (
              <span className="tag !border-warn/40 !text-warn" role="status">
                unsaved
              </span>
            )}
          </div>

          <div className="ml-auto flex flex-wrap gap-2 max-sm:ml-0 max-sm:w-full">
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
          <Banner tone={noteTone === "err" ? "err" : "ok"} className="mt-2.5">
            {note}
          </Banner>
        )}
      </div>

      {!path ? (
        <EmptyState
          icon="M4 5h16v14H4zM4 10h16"
          title="No spec open"
          sub="Pick one above to edit and render it — or start a new demo. Scaffolding a starter spec and capturing one from your browser both work with no API key."
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/new" className="btn btn-brand">
              New demo
            </Link>
            <Link href="/gallery" className="btn btn-ghost">
              Browse the gallery
            </Link>
          </div>
        </EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {/* ---- left: the spec ---- */}
          <div className="flex min-w-0 flex-col gap-5">
            <div className="card min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <Tabs
                  tabs={TABS}
                  active={tab}
                  onChange={setTab}
                  label="Spec editor view"
                  idBase="spec"
                  className="inline-flex flex-wrap rounded-xl border border-line bg-bg2 p-1"
                />
                {summary && tab !== "output" && <SpecChips summary={summary} />}
                {tab === "output" && (
                  <span className="text-xs text-faint" role="status">
                    {syncing ? "Writing to the spec…" : "Changes are written to the spec"}
                  </span>
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

              <TabPanel idBase="spec" active={tab}>
                {tab === "beats" ? (
                  /* One scroller, not two: this pane used to cap at 720px and
                     contain a 420px one, so the inner list trapped the wheel
                     and the outer scrollbar moved nothing. */
                  <div className="space-y-4 rounded-xl border border-line bg-bg2 p-3">
                    <BeatStrip
                      path={path}
                      steps={summary?.outline ?? []}
                      beats={beats.beats}
                      durationMs={beats.durationMs}
                      rendered={beats.rendered}
                      busy={busy}
                      onChanged={() => loadSpec(path)}
                      onError={(m) => {
                        setNoteTone("err");
                        setNote(m);
                      }}
                    />
                    <div className="border-t border-line pt-4">
                      <p className="mb-2 text-[13px] font-medium text-ink">Media</p>
                      <MediaLibrary
                        path={path}
                        busy={busy}
                        onAdded={(rel) => {
                          setNoteTone("ok");
                          setNote(`Added ${rel} — reference it with \`image: { file: ${rel} }\``);
                        }}
                      />
                    </div>
                  </div>
                ) : tab === "script" ? (
                  <div className="rounded-xl border border-line bg-bg2 p-3">
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
                  <div className="space-y-4">
                    {/* ---- formats ----
                        The product's headline feature, and until now the one
                        thing Studio could not set. */}
                    <fieldset className="rounded-xl border border-line bg-bg2 p-3.5">
                      <legend className="px-1.5 text-xs font-medium text-muted">
                        Output formats
                      </legend>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-sm:grid-cols-1">
                        {FORMATS.map((f) => {
                          const only = form[f.key] && formatsOn === 1;
                          return (
                            <Check
                              key={f.key}
                              checked={form[f.key]}
                              disabled={only}
                              onChange={(v) => set(f.key, v)}
                              label={f.label}
                              hint={
                                only
                                  ? "A spec has to render at least one thing — turn another on first."
                                  : f.hint
                              }
                            />
                          );
                        })}
                      </div>
                      <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-faint">
                        {summary?.options.mp4 || summary?.options.gif
                          ? "Paths already in the spec are kept as they are — a checkbox never moves a file you named."
                          : "New formats land in out/, named after this spec."}
                      </p>
                    </fieldset>

                    <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                      <label className="block">
                        <span className="label">Preset</span>
                        <select
                          className="input"
                          value={form.preset}
                          onChange={(e) => set("preset", e.target.value)}
                        >
                          {PRESETS.map((p) => (
                            <option key={p}>{p}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="label">Device frame</span>
                        <select
                          className="input"
                          value={form.frame}
                          onChange={(e) => set("frame", e.target.value)}
                        >
                          {FRAMES.map((f) => (
                            <option key={f}>{f}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="label">Speed</span>
                        <select
                          className="input"
                          value={form.speed}
                          onChange={(e) => set("speed", Number(e.target.value))}
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
                          value={form.targetDuration}
                          onChange={(e) => set("targetDuration", e.target.value)}
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
                            value={form.terminalTheme}
                            onChange={(e) => set("terminalTheme", e.target.value)}
                          >
                            {/* Served from src/terminal/themes.ts rather than
                                hand-copied here — one list, no drift. */}
                            {(themes.length ? themes : [form.terminalTheme]).map((t) => (
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
                            <div id="opt-zoomoutput" className="text-sm font-medium">
                              Camera follows output
                            </div>
                            <div
                              id="opt-zoomoutput-d"
                              className="text-xs leading-relaxed text-faint"
                            >
                              After each command, ease the shot onto what it printed. Off by default,
                              so turning it on re-shoots this demo — its rendered media will change.
                            </div>
                          </div>
                          <Toggle
                            checked={form.zoomOutput}
                            onChange={(v) => set("zoomOutput", v)}
                            labelledBy="opt-zoomoutput"
                            describedBy="opt-zoomoutput-d"
                          />
                        </div>
                        {form.zoomOutput && (
                          <label className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                            <span className="label mb-0" title="Taller output is framed at its tail">
                              Longest shot
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={120}
                              className="input !w-20 !py-1.5"
                              value={form.zoomRows}
                              onChange={(e) => set("zoomRows", Number(e.target.value))}
                            />
                            <span className="text-xs text-faint">rows</span>
                          </label>
                        )}
                      </div>
                    )}

                    <div className="rounded-xl border border-line bg-bg2 p-3.5">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div id="opt-timeline" className="text-sm font-medium">
                            Reproducible timeline
                          </div>
                          <div id="opt-timeline-d" className="text-xs leading-relaxed text-faint">
                            Renders byte-identical media on any machine, so committed demo media only
                            changes when the demo does. Turn off to film the app&apos;s own animation
                            in real time.
                          </div>
                        </div>
                        <Toggle
                          checked={form.timeline}
                          onChange={(v) => set("timeline", v)}
                          labelledBy="opt-timeline"
                          describedBy="opt-timeline-d"
                        />
                      </div>
                    </div>

                    <div className="rounded-xl border border-line bg-bg2 p-3.5">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div id="opt-html" className="text-sm font-medium">
                            Interactive HTML
                          </div>
                          <div id="opt-html-d" className="text-xs leading-relaxed text-faint">
                            A self-contained click-through with hotspots and deep links — one file, no
                            hosting.{" "}
                            {summary?.branchCount
                              ? "This spec branches, so it's the only output that carries every path."
                              : ""}
                          </div>
                        </div>
                        <Toggle
                          checked={form.interactive}
                          onChange={(v) => set("interactive", v)}
                          labelledBy="opt-html"
                          describedBy="opt-html-d"
                          disabled={form.interactive && formatsOn === 1}
                        />
                      </div>
                    </div>

                    <div className="rounded-xl border border-line bg-bg2 p-3.5">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div id="opt-narration" className="text-sm font-medium">
                            Narration
                          </div>
                          <div id="opt-narration-d" className="text-xs leading-relaxed text-faint">
                            Speaks the <code>say:</code> line beside each caption, and stretches the
                            timeline so the picture waits for the voice.{" "}
                            {form.narration && summary
                              ? summary.options.audio.spokenLines
                                ? `${summary.options.audio.spokenLines} steps carry a line.`
                                : "No step carries a line yet, so this would render silent."
                              : ""}
                          </div>
                        </div>
                        <Toggle
                          checked={form.narration}
                          onChange={(v) => set("narration", v)}
                          labelledBy="opt-narration"
                          describedBy="opt-narration-d"
                        />
                      </div>

                      {form.narration && summary?.valid && !summary.options.audio.spokenLines && (
                        <Banner tone="warn" className="mt-3">
                          Narration is on but no step carries a <code>say:</code> line — this would
                          render silent. The Script tab can draft one for each moment.
                        </Banner>
                      )}

                      {form.narration && (
                        <div className="mt-3 space-y-3 border-t border-line pt-3">
                          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                            <label className="flex items-center gap-2">
                              <span className="label mb-0">Voice</span>
                              <select
                                className="input !w-32 !py-1.5"
                                value={form.voiceProvider}
                                onChange={(e) => set("voiceProvider", e.target.value)}
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
                                value={form.voiceId}
                                onChange={(e) => set("voiceId", e.target.value)}
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
                                className="input !w-44 !py-1.5"
                                value={form.audioFit}
                                onChange={(e) => set("audioFit", e.target.value)}
                              >
                                {FITS.map((f) => (
                                  <option key={f.value} value={f.value} title={f.title}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="label mb-0" title="Clicks, key texture, card sweeps">
                                Effects
                              </span>
                              <select
                                className="input !w-28 !py-1.5"
                                value={form.sfx}
                                onChange={(e) => set("sfx", e.target.value)}
                              >
                                <option value="none">None</option>
                                <option value="subtle">Subtle</option>
                                <option value="full">Full</option>
                              </select>
                            </label>
                          </div>

                          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                            <label className="flex items-center gap-2">
                              <span
                                className="label mb-0"
                                title="A file you have the rights to — Reel ships none"
                              >
                                Music bed
                              </span>
                              <input
                                className="input !w-52 !py-1.5"
                                value={form.music}
                                onChange={(e) => set("music", e.target.value)}
                                placeholder="bed.mp3"
                              />
                            </label>
                            {form.music.trim() && (
                              <label className="flex items-center gap-2">
                                <span className="label mb-0" title="Honoured exactly, in decibels">
                                  Duck
                                </span>
                                <input
                                  type="number"
                                  max={0}
                                  min={-40}
                                  className="input !w-20 !py-1.5"
                                  value={form.musicDuck}
                                  onChange={(e) => set("musicDuck", Number(e.target.value))}
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

                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                      <Toggle
                        checked={form.subtitles}
                        onChange={(v) => set("subtitles", v)}
                        label="Subtitles (SRT/VTT)"
                      />
                      <label className="flex items-center gap-2">
                        <span
                          className="label mb-0"
                          title={
                            form.narration
                              ? "Subtitle variants, and a spoken track per language from the same recording"
                              : "Localized subtitle variants"
                          }
                        >
                          Localize
                        </span>
                        <input
                          className="input !w-40 !py-1.5"
                          value={form.languages}
                          onChange={(e) => set("languages", e.target.value)}
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
                          value={form.retries}
                          onChange={(e) => set("retries", Number(e.target.value))}
                        />
                      </label>
                    </div>
                  </div>
                ) : (
                  /* Line numbers make a YAML error ("steps.3.click") findable. */
                  <div className="flex overflow-hidden rounded-xl border border-line2 bg-bg2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
                    <pre
                      aria-hidden
                      className="select-none border-r border-line px-2.5 py-2.5 text-right font-mono text-[12.5px] leading-relaxed text-faint"
                    >
                      {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                    </pre>
                    <textarea
                      ref={editor}
                      aria-label="Spec YAML"
                      className="min-h-[520px] flex-1 resize-y bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-faint"
                      value={raw}
                      onChange={(e) => {
                        editedBy.current = "yaml";
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
                          editedBy.current = "yaml";
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
              </TabPanel>

              {warnings.length > 0 && (
                <ul
                  role="status"
                  aria-live="polite"
                  className="mt-3 space-y-1 rounded-lg border border-warn/25 bg-warn/[0.06] p-3 text-[12.5px] text-warn"
                >
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* ---- right: the result ----
              Preview above the log: the render is the point, and the log is
              only interesting while it is still running or when it failed.
              `contents` below lg so the two cards join the single column
              instead of staying a nested grid child — the breakpoint has to be
              the same one the sticky rule uses, or the card sticks inside a
              stack it is no longer beside. */}
          <div className="flex min-w-0 flex-col gap-5 max-lg:contents">
            <div className="card min-w-0 lg:sticky lg:top-[92px]">
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

            <div className="card min-w-0">
              <h2 className="mb-3 text-[15px] font-semibold">Run log</h2>
              <LogConsole lines={logs} running={busy} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
