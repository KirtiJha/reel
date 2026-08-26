"use client";
import { useState } from "react";
import { postJSON, type OutlineStep } from "@/lib/api";

/**
 * The beat strip.
 *
 * Not a frame-accurate timeline. Reel's unit is the beat, and drawing a
 * scrubber would invent precision the model does not have — a demo is a list of
 * moments, not a waveform.
 *
 * Reordering writes the steps in the spec. The file is what changed, which is
 * the whole point: a demo rearranged by dragging still diffs in a pull request.
 */

export interface Beat {
  label: string;
  t: number;
}

export function BeatStrip({
  path,
  steps,
  beats,
  durationMs,
  rendered,
  busy,
  onChanged,
  onError,
}: {
  path: string;
  steps: OutlineStep[];
  beats: Beat[];
  durationMs: number;
  rendered: boolean;
  busy: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);

  async function move(from: number, to: number) {
    if (from === to) return;
    setMoving(true);
    try {
      await postJSON("/api/move-step", { path, from, to });
      onChanged();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-faint">
          Drag to reorder — it rewrites the steps in the spec, so the change shows up in a diff.
        </p>
        {rendered && (
          <span className="whitespace-nowrap rounded-lg border border-line bg-bg2 px-2.5 py-1 text-xs text-muted">
            {beats.length} beats · {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {!rendered && (
        <p className="rounded-lg border border-line bg-bg2 px-3 py-2 text-[13px] text-muted">
          Beat times come from the last render, so they appear once you record. The order below is
          the spec&apos;s.
        </p>
      )}

      <ol className="space-y-1.5">
        {steps.map((step, i) => {
          const beat = step.kind === "beat" || step.kind === "card";
          return (
            <li
              key={step.index}
              draggable={!busy && !moving}
              onDragStart={() => setDragging(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null) void move(dragging, i);
                setDragging(null);
                setOver(null);
              }}
              className={`flex cursor-grab items-center gap-3 rounded-lg border px-3 py-2 transition ${
                over === i && dragging !== null && dragging !== i
                  ? "border-brand bg-brand/[0.08]"
                  : beat
                    ? "border-line bg-bg2"
                    : "border-line/60 bg-bg2/50"
              } ${dragging === i ? "opacity-40" : ""}`}
            >
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-faint">
                {step.index}
              </span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                  beat ? "bg-brand/15 text-brand" : "text-faint"
                }`}
              >
                {step.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{step.label}</span>
              {beatTimeFor(step, beats) !== null && (
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {(beatTimeFor(step, beats)! / 1000).toFixed(1)}s
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The time a beat happened, when the last render knows it.
 *
 * Matched by label rather than by position: a reorder changes positions
 * immediately but the stamp still describes the render before it, and lining
 * those up by index would put confident, wrong numbers next to every step.
 */
function beatTimeFor(step: OutlineStep, beats: Beat[]): number | null {
  if (step.kind !== "beat" && step.kind !== "card") return null;
  const name = step.label.replace(/^(beat|card)\s+/, "").replace(/^[“"]|[”"]$/g, "");
  return beats.find((b) => b.label === name)?.t ?? null;
}
