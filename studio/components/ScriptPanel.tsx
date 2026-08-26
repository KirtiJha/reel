"use client";
import { useState } from "react";
import { Spinner } from "@/components/bits";
import { mediaUrl, runJob, type Direction, type LogLine, type Script } from "@/lib/api";

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
  const [playing, setPlaying] = useState<number | null>(null);
  const [heard, setHeard] = useState<Record<number, number>>({});
  const [note, setNote] = useState<string | null>(null);

  /** Speak one line. The cache makes a second listen instant. */
  async function speak(index: number, text: string) {
    setPlaying(index);
    setNote(null);
    const done = await runJob("/api/say", { path, text }, onLog);
    setPlaying(null);
    if (!done.ok) {
      setNote(done.hint ? `${done.error} — ${done.hint}` : (done.error ?? "failed"));
      return;
    }
    const ms = done.result?.durationMs as number | undefined;
    if (ms) setHeard((p) => ({ ...p, [index]: ms }));
    const file = done.result?.file as string | undefined;
    if (file) void new Audio(mediaUrl(file)).play().catch(() => {});
  }

  async function run(kind: "narrate" | "direct", extra: Record<string, unknown> = {}) {
    onBusy(kind);
    setNote(null);
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
      setNote("Proposed lines are in the log — paste the ones you want.");
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
          const ms = heard[line.index] ?? line.estimatedMs;
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
                  <span className={`text-xs ${long ? "text-warn" : "text-muted"}`}>
                    {heard[line.index] ? "" : "~"}
                    {(ms / 1000).toFixed(1)}s
                  </span>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busy || playing !== null}
                    onClick={() => speak(line.index, line.text)}
                    title="Speak this line"
                  >
                    {playing === line.index ? <Spinner /> : "▶"}
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
            Draft a line for each
          </button>
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

      {note && <p className="text-[13px] text-err">{note}</p>}
    </div>
  );
}
