"use client";
import type { OutlineStep, SpecSummary } from "@/lib/api";

/**
 * The spec as a storyboard.
 *
 * YAML tells you what a demo says; it doesn't show you its shape. This does —
 * and it's the only place a branch reads as a fork rather than as indentation.
 */

/** Steps grouped by what they do, so the outline is scannable by colour. */
const GROUPS: Record<string, { tone: string; ring: string }> = {
  action: { tone: "text-brand", ring: "border-brand/40 bg-brand/10" },
  narrate: { tone: "text-brand2", ring: "border-brand2/40 bg-brand2/10" },
  wait: { tone: "text-muted", ring: "border-line2 bg-elev" },
  assert: { tone: "text-ok", ring: "border-ok/40 bg-ok/10" },
  terminal: { tone: "text-warn", ring: "border-warn/40 bg-warn/10" },
  branch: { tone: "text-brand", ring: "border-brand/50 bg-brand/15" },
};

const KIND_GROUP: Record<string, keyof typeof GROUPS> = {
  goto: "action",
  click: "action",
  dblclick: "action",
  hover: "action",
  type: "action",
  fill: "action",
  press: "action",
  scrollTo: "action",
  scroll: "action",
  caption: "narrate",
  card: "narrate",
  callout: "narrate",
  say: "narrate",
  beat: "narrate",
  zoom: "narrate",
  waitFor: "wait",
  waitForUrl: "wait",
  waitForNetworkIdle: "wait",
  hold: "wait",
  expect: "assert",
  expectOutput: "assert",
  run: "terminal",
  clear: "terminal",
  show: "terminal",
  branch: "branch",
};

const ICONS: Record<string, string> = {
  goto: "→",
  click: "◉",
  dblclick: "◎",
  hover: "◌",
  type: "⌨",
  fill: "⌨",
  press: "⏎",
  scrollTo: "↧",
  scroll: "↧",
  caption: "❝",
  card: "▤",
  callout: "◈",
  say: "♪",
  beat: "◆",
  zoom: "⌕",
  waitFor: "⏱",
  waitForUrl: "⏱",
  waitForNetworkIdle: "⏱",
  hold: "⏸",
  expect: "✓",
  expectOutput: "✓",
  run: "❯",
  clear: "␡",
  show: "⇄",
  branch: "⑂",
};

function Row({
  step,
  depth = 0,
  onToggleHidden,
}: {
  step: OutlineStep;
  depth?: number;
  /** Absent inside a branch path, where a step's index isn't a top-level one. */
  onToggleHidden?: (step: OutlineStep) => void;
}) {
  const group = GROUPS[KIND_GROUP[step.kind] ?? "wait"]!;
  const canHide = step.hidden !== undefined && onToggleHidden;
  return (
    <li className="group">
      <div
        className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-elev"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span
          className={`mt-[1px] inline-flex h-[19px] w-[19px] flex-none items-center justify-center rounded-md border text-[11px] ${group.ring} ${group.tone}`}
          aria-hidden
        >
          {ICONS[step.kind] ?? "•"}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`text-[12.5px] font-medium ${group.tone}`}>{step.kind}</span>{" "}
          <span
            className={`break-words font-mono text-[12px] ${step.hidden ? "text-faint line-through" : "text-muted"}`}
          >
            {step.label.slice(step.kind.length).trim()}
          </span>
        </span>
        {canHide && (
          <button
            onClick={() => onToggleHidden(step)}
            className={`tag flex-none transition ${
              step.hidden ? "!border-warn/40 !bg-warn/10 !text-warn" : "opacity-0 group-hover:opacity-100"
            }`}
            title={
              step.hidden
                ? "Runs off camera. Click to film it again."
                : "Run this command off camera — it still runs, and still counts for reel check"
            }
          >
            {step.hidden ? "hidden" : "hide"}
          </button>
        )}
      </div>

      {step.branch && (
        <div className="ml-[18px] mt-1 border-l border-dashed border-line2 pl-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
            {step.branch.prompt}
          </div>
          <div className="space-y-2.5">
            {step.branch.paths.map((p) => (
              <div key={p.label}>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold">{p.label}</span>
                  {p.isDefault ? (
                    <span
                      className="tag !border-brand/40 !bg-brand/10 !text-brand"
                      title="The path the video follows"
                    >
                      in video
                    </span>
                  ) : (
                    <span className="tag" title="Recorded for the interactive build only">
                      interactive only
                    </span>
                  )}
                </div>
                <ul>
                  {p.steps.map((s) => (
                    <Row key={`${p.label}-${s.index}`} step={s} depth={depth + 1} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

export function SpecOutline({
  summary,
  onToggleHidden,
}: {
  summary: SpecSummary | null;
  onToggleHidden?: (step: OutlineStep) => void;
}) {
  if (!summary) {
    return <p className="text-sm text-faint">Select a spec to see its shape.</p>;
  }
  if (!summary.valid) {
    return (
      <div>
        <p className="mb-2 text-sm font-medium text-warn">This spec doesn&apos;t parse yet.</p>
        <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-muted">
          {summary.errors.slice(0, 6).map((e, i) => (
            <li key={i} className="font-mono">
              {e}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <ul className="-mx-2 max-h-[420px] space-y-0.5 overflow-y-auto">
      {summary.outline.map((s) => (
        <Row key={s.index} step={s} onToggleHidden={onToggleHidden} />
      ))}
    </ul>
  );
}

/** At-a-glance facts about the loaded spec. */
export function SpecChips({ summary }: { summary: SpecSummary | null }) {
  if (!summary?.valid) return null;
  const o = summary.options;
  const chips: { label: string; title: string; tone?: string }[] = [
    { label: `${summary.stepCount} steps`, title: "Top-level steps" },
  ];
  if (summary.kind === "terminal") {
    chips.push({ label: "terminal", title: "Runs real commands in a rendered terminal", tone: "warn" });
  }
  if (summary.branchCount) {
    chips.push({
      label: `${summary.branchCount} branch${summary.branchCount > 1 ? "es" : ""}`,
      title: "The video follows one path; the interactive build carries them all",
      tone: "brand",
    });
  }
  if (summary.variants > 1) {
    chips.push({
      label: `${summary.variants} variants`,
      title: `${summary.matrix?.viewports.join(", ")} × ${summary.matrix?.themes.join(", ")}`,
      tone: "brand",
    });
  }
  chips.push({
    label: o.timeline ? "reproducible" : "wall-clock",
    title: o.timeline
      ? "Virtual timeline: the same spec renders byte-identical media on any machine"
      : "Wall-clock capture: output length varies with machine speed",
    tone: o.timeline ? "ok" : "warn",
  });
  if (o.speed !== 1) chips.push({ label: `${o.speed}× speed`, title: "Playback rate for authored durations" });
  if (o.targetDuration) chips.push({ label: `→ ${o.targetDuration}`, title: "Fitted to a target duration" });
  if (o.retries) chips.push({ label: `${o.retries} retries`, title: "Transient step failures are retried" });
  if (o.audio.enabled) {
    // A configured soundtrack with nothing to say is a real and easily missed
    // mistake, so the count is the chip rather than the word "narrated".
    chips.push(
      o.audio.spokenLines
        ? {
            label: `${o.audio.spokenLines} spoken`,
            title: `Narrated with ${o.audio.provider}${o.audio.music ? ", over a music bed" : ""}`,
            tone: "brand",
          }
        : {
            label: "narration, no lines",
            title: "Audio is configured but no step carries a `say:` line, so this renders silent",
            tone: "warn",
          },
    );
  }

  const toneClass = (t?: string) =>
    t === "ok"
      ? "!border-ok/40 !bg-ok/10 !text-ok"
      : t === "warn"
        ? "!border-warn/40 !bg-warn/10 !text-warn"
        : t === "brand"
          ? "!border-brand/40 !bg-brand/10 !text-brand"
          : "";

  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span key={c.label} className={`tag ${toneClass(c.tone)}`} title={c.title}>
          {c.label}
        </span>
      ))}
    </div>
  );
}
