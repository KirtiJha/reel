"use client";
import { useState } from "react";
import { Banner, Spinner } from "@/components/bits";
import {
  mediaUrl,
  postJSON,
  runJob,
  type Direction,
  type LogLine,
  type Script,
  type SilentMoment,
} from "@/lib/api";

/**
 * The script, as a document.
 *
 * A view onto `reel narrate`, `reel say` and `reel direct` — not a second
 * implementation of any of them. Every button here is a command that works
 * without opening Studio, which is what keeps the two surfaces equal.
 *
 * What it adds over the terminal is the part that is irreducibly aural: you can
 * hear whether a sentence lands, and see its length next to the words that
 * caused it. No log output answers that.
 */

/** Past this, a single line is a paragraph and the picture waits for it. */
const LONG_LINE_MS = 9_000;

/** A drafted line, and the moment it was drafted for. */
interface Proposal {
  where: string;
  text: string;
  /** Length, once something has said or counted it. */
  ms?: number;
  /** True when `ms` is a word-count estimate rather than a synthesized length. */
  estimated?: boolean;
}

/**
 * Line the pending proposals back up with the spec's silent moments.
 *
 * Accepting one line rewrites the spec, so the list it was numbered against is
 * a list short of an entry — and for a beat, a step longer as well. Walking
 * both in order and matching the label is exact, because the proposals were
 * made from that same walk and accepting only ever removes from it.
 */
function align(moments: SilentMoment[], proposals: Proposal[]): { index: number; p: Proposal }[] {
  const out: { index: number; p: Proposal }[] = [];
  let cursor = 0;
  for (const p of proposals) {
    const i = moments.findIndex((m, at) => at >= cursor && m.where === p.where);
    if (i < 0) continue; // filled, or gone from the spec — nothing left to do
    cursor = i + 1;
    out.push({ index: i, p });
  }
  return out;
}

export function ScriptPanel({
  path,
  script,
  busy,
  onLog,
  onBusy,
  onReload,
}: {
  path: string;
  script: Script | null;
  busy: boolean;
  onLog: (line: LogLine) => void;
  onBusy: (kind: string | null) => void;
  onReload: () => void;
}) {
  // null means "not asked yet", which reads differently from "asked, and there
  // is nothing to propose". An empty list would say the same thing for both.
  const [directions, setDirections] = useState<Direction[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [heard, setHeard] = useState<Record<number, { ms: number; cached: boolean }>>({});
  const [note, setNote] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  /** Drafted lines waiting to be accepted, and where each belongs. */
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [moments, setMoments] = useState<SilentMoment[]>([]);
  const [accepting, setAccepting] = useState<string | null>(null);

  /** Speak one line. The cache makes a second listen instant. */
  async function speak(index: number, text: string) {
    setPlaying(`line-${index}`);
    setNote(null);
    const done = await runJob("/api/say", { path, text }, onLog);
    setPlaying(null);
    if (!done.ok) {
      setNote(done.hint ? `${done.error} — ${done.hint}` : (done.error ?? "failed"));
      return;
    }
    const ms = done.result?.durationMs as number | undefined;
    if (ms) setHeard((p) => ({ ...p, [index]: { ms, cached: Boolean(done.result?.cached) } }));
    const file = done.result?.file as string | undefined;
    if (file) void new Audio(mediaUrl(file)).play().catch(() => {});
  }

  /**
   * How long a proposed line runs.
   *
   * `dryRun` counts words and needs no key, no network and no spend — which is
   * the right default for a sentence you are still editing. Hearing it is the
   * other button, and it is the one that costs something.
   */
  async function measure(where: string, text: string, dryRun: boolean) {
    setPlaying(`${dryRun ? "est" : "say"}-${where}`);
    setNote(null);
    const done = await runJob("/api/say", { path, text, dryRun }, onLog);
    setPlaying(null);
    if (!done.ok) {
      setNote(done.hint ? `${done.error} — ${done.hint}` : (done.error ?? "failed"));
      return;
    }
    const ms = done.result?.durationMs as number | undefined;
    setProposals((list) =>
      (list ?? []).map((p) =>
        p.where === where ? { ...p, ms, estimated: Boolean(done.result?.estimated) } : p,
      ),
    );
    const file = done.result?.file as string | undefined;
    if (file) void new Audio(mediaUrl(file)).play().catch(() => {});
  }

  /** Write one accepted line into the spec, under the moment it was drafted for. */
  async function accept(index: number, p: Proposal) {
    setAccepting(p.where);
    setNote(null);
    try {
      const r = await postJSON<{ ok: boolean; error?: string; where?: string }>("/api/accept-say", {
        path,
        index,
        where: p.where,
        text: p.text,
      });
      if (!r.ok) {
        setNote(r.error ?? "Could not write that line.");
        return;
      }
      setProposals((list) => (list ?? []).filter((x) => x.where !== p.where));
      // The spec on disk moved, so both the moment list this panel numbers
      // against and the editor above it are now behind the file.
      const fresh = await postJSON<{ moments: SilentMoment[] }>("/api/silent", { path });
      setMoments(fresh.moments ?? []);
      setOk(`Written under ${p.where}.`);
      onReload();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setAccepting(null);
    }
  }

  async function run(kind: "narrate" | "direct", extra: Record<string, unknown> = {}) {
    onBusy(kind);
    setNote(null);
    setOk(null);
    const done = await runJob(`/api/${kind}`, { path, ...extra }, onLog);
    onBusy(null);
    if (!done.ok) {
      setNote(done.hint ? `${done.error} — ${done.hint}` : (done.error ?? "failed"));
      return;
    }
    if (kind === "direct") {
      setDirections((done.result?.directions as Direction[]) ?? []);
      // Direction that was written changed the file on disk, so the spec in the
      // editor is now behind it.
      if (extra.write) onReload();
    }
    if (kind === "narrate") {
      // `draftNarration` returns sentences in the order the silent moments were
      // walked and nothing else identifying them, so the moments are fetched
      // here to give each line somewhere to go.
      const lines = (done.result?.proposed as string[]) ?? [];
      const found = await postJSON<{ moments: SilentMoment[] }>("/api/silent", { path }).catch(
        () => ({ moments: [] as SilentMoment[] }),
      );
      setMoments(found.moments ?? []);
      setProposals(
        (found.moments ?? [])
          .map((m, i) => ({ where: m.where, text: (lines[i] ?? "").trim() }))
          .filter((p) => p.text),
      );
    }
  }

  if (!script) {
    return <p className="text-[13px] text-faint">Select a spec to read its script.</p>;
  }

  const mins = Math.floor(script.estimatedMs / 60_000);
  const secs = Math.round((script.estimatedMs % 60_000) / 1000);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-faint">
          Every spoken line, in order. How long a demo talks for is the one thing you cannot
          tell by reading the spec.
        </p>
        <span className="whitespace-nowrap rounded-lg border border-line bg-bg2 px-2.5 py-1 text-xs text-muted">
          {script.lines.length} lines · {script.words} words · ~{mins ? `${mins}m ` : ""}
          {secs}s
        </span>
      </div>

      {script.lines.length === 0 && (
        <p className="rounded-lg border border-line bg-bg2 px-3 py-2 text-[13px] text-muted">
          Nothing is spoken yet. A caption speaks its own text, so adding one is enough.
        </p>
      )}

      <ol className="space-y-2">
        {script.lines.map((line) => {
          const spoken = heard[line.index];
          const ms = spoken?.ms ?? line.estimatedMs;
          const long = ms > LONG_LINE_MS;
          return (
            <li
              key={line.index}
              className={`rounded-xl border p-3 ${
                long ? "border-warn/30 bg-warn/[0.06]" : "border-line bg-bg2"
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <span className="text-xs text-faint">{line.where}</span>
                <span className="flex items-center gap-2">
                  {spoken?.cached && (
                    <span className="tag" title="Already in .reel-cache/voice — this cost nothing">
                      cached
                    </span>
                  )}
                  <span className={`text-xs ${long ? "text-warn" : "text-muted"}`}>
                    {spoken ? "" : "~"}
                    {(ms / 1000).toFixed(1)}s
                  </span>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy || playing !== null}
                    onClick={() => speak(line.index, line.text)}
                    title="Speak this line"
                    aria-label={`Speak line ${line.index}`}
                  >
                    {playing === `line-${line.index}` ? <Spinner /> : <span aria-hidden>▶</span>}
                  </button>
                </span>
              </div>
              <p className="text-[13px] leading-relaxed text-ink">{line.text}</p>
              {long && (
                <p className="mt-1.5 text-xs text-warn">
                  Long enough that the picture waits for it. Split it, or set
                  <code className="mx-1">audio.fit: flow</code>.
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {script.silent.length > 0 && (
        <div className="rounded-xl border border-line bg-bg2 p-3">
          <p className="text-[13px] text-muted">
            {script.silent.length} moment{script.silent.length > 1 ? "s" : ""} say nothing:{" "}
            <span className="text-faint">{script.silent.slice(0, 6).join(", ")}</span>
            {script.silent.length > 6 ? " …" : ""}
          </p>
          <button
            className="btn btn-sm btn-ghost mt-2"
            disabled={busy}
            onClick={() => run("narrate")}
          >
            {proposals ? "Draft again" : "Draft a line for each"}
          </button>
        </div>
      )}

      {/* ---- proposed lines ----
          Editable and accepted one at a time. A draft is a first guess at
          someone else's voice: the useful unit is "that one, with a word
          changed", which is neither "apply all" nor a log to copy out of. */}
      {proposals !== null && (
        <div className="rounded-xl border border-line bg-bg2 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-ink">
              Proposed lines
              {proposals.length > 0 && <span className="ml-1.5 text-faint">{proposals.length}</span>}
            </p>
            <p className="text-xs text-faint">Accepting writes <code>say:</code> into the spec.</p>
          </div>

          {proposals.length === 0 ? (
            <p className="text-xs text-faint">
              Nothing pending — every drafted line has been accepted or dropped.
            </p>
          ) : (
            <ul className="space-y-2">
              {align(moments, proposals).map(({ index, p }) => (
                <li key={p.where} className="rounded-lg border border-line bg-bg p-2.5">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-faint">{p.where}</span>
                    <span className="flex items-center gap-2">
                      {p.ms !== undefined && (
                        <span
                          className={`text-xs ${p.ms > LONG_LINE_MS ? "text-warn" : "text-muted"}`}
                          title={
                            p.estimated
                              ? "Estimated from the word count — no key, no network, no spend"
                              : "Measured from the synthesized audio"
                          }
                        >
                          {p.estimated ? "~" : ""}
                          {(p.ms / 1000).toFixed(1)}s
                        </span>
                      )}
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={busy || playing !== null || accepting !== null}
                        onClick={() => measure(p.where, p.text, true)}
                        title="How long this runs, counted from the words — needs no API key"
                      >
                        {playing === `est-${p.where}` ? <Spinner /> : "Length"}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={busy || playing !== null || accepting !== null}
                        onClick={() => measure(p.where, p.text, false)}
                        title="Speak it in this demo's voice"
                        aria-label={`Speak the proposed line for ${p.where}`}
                      >
                        {playing === `say-${p.where}` ? <Spinner /> : <span aria-hidden>▶</span>}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busy || accepting !== null || !p.text.trim()}
                        onClick={() => accept(index, p)}
                        title={`Write this line into the spec under ${p.where}`}
                      >
                        {accepting === p.where ? <Spinner /> : "Accept"}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={busy || accepting !== null}
                        onClick={() =>
                          setProposals((list) => (list ?? []).filter((x) => x.where !== p.where))
                        }
                        title="Drop this proposal"
                        aria-label={`Drop the proposed line for ${p.where}`}
                      >
                        <span aria-hidden>✕</span>
                      </button>
                    </span>
                  </div>
                  <label>
                    <span className="sr-only">Proposed line for {p.where}</span>
                    <textarea
                      className="input !py-1.5 text-[13px] leading-relaxed"
                      rows={2}
                      value={p.text}
                      onChange={(e) =>
                        setProposals((list) =>
                          (list ?? []).map((x) =>
                            x.where === p.where
                              ? { ...x, text: e.target.value, ms: undefined, estimated: undefined }
                              : x,
                          ),
                        )
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---- direction ---- */}
      <div className="rounded-xl border border-line bg-bg2 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-ink">Direction</p>
          <span className="flex gap-2">
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run("direct")}>
              Propose
            </button>
            {!!directions?.length && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => run("direct", { write: true })}
              >
                Apply {directions.length}
              </button>
            )}
          </span>
        </div>
        {directions === null ? (
          <p className="text-xs text-faint">
            Proposes a mark on the element a line is about, and a wide shot where a chapter opens
            into a close-up. Nothing is written until you apply it.
          </p>
        ) : directions.length === 0 ? (
          <p className="text-xs text-faint">
            Nothing to propose — every narrated line already has something to look at.
          </p>
        ) : (
          <ul className="space-y-2">
            {directions.map((d, i) => (
              <li key={i} className="rounded-lg border border-line bg-bg px-3 py-2">
                <p className="text-xs text-faint">before step {d.index + 1} — {d.because}</p>
                <pre className="mt-1 overflow-x-auto text-[12px] text-brand">
                  {JSON.stringify(d.step)}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </div>

      {ok && <Banner tone="ok">{ok}</Banner>}
      {note && (
        <p role="alert" aria-live="assertive" className="text-[13px] text-err">
          {note}
        </p>
      )}
    </div>
  );
}
