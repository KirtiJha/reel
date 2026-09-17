"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Banner, Spinner } from "@/components/bits";
import {
  getJSON,
  mediaUrl,
  runJob,
  type Comparable,
  type DiffResult,
  type LogLine,
  type ReviewResult,
  type Verdict,
} from "@/lib/api";

/**
 * What changed, in the panel that shows the render.
 *
 * Studio could record a demo and then had nothing to say about it — the one
 * question a re-render raises ("is it still telling the truth?") was answerable
 * only from a terminal. This is `reel diff` and `reel review` behind two
 * buttons, wrapping the same functions the CLI calls, including the threshold
 * they are held to.
 *
 * The two are deliberately separable. The pixel pass is arithmetic and needs
 * nothing; the judgement needs a model. Someone with no key still gets the half
 * that works, rather than a disabled button and an advert for an API.
 */

const BADGE: Record<Verdict, { mark: string; tone: string; title: string }> = {
  "stale-caption": {
    mark: "✗",
    tone: "!border-err/40 !bg-err/10 !text-err",
    title: "A caption no longer matches what is on screen",
  },
  content: {
    mark: "!",
    tone: "!border-warn/40 !bg-warn/10 !text-warn",
    title: "What the demo shows changed",
  },
  unreviewed: { mark: "?", tone: "", title: "Beyond the review budget" },
  cosmetic: { mark: "·", tone: "", title: "Cosmetic only" },
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const share = (f: number) => (f >= 0.01 ? `${(f * 100).toFixed(1)}%` : `${(f * 100).toFixed(2)}%`);

export function ChangePanel({
  path,
  busy,
  modelConfigured,
  /** Bumped by the page after every render, so the pair is re-read. */
  renders,
  onLog,
  onBusy,
}: {
  path: string;
  busy: boolean;
  modelConfigured: boolean;
  renders: number;
  onLog: (line: LogLine) => void;
  onBusy: (kind: string | null) => void;
}) {
  const [pair, setPair] = useState<Comparable | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [running, setRunning] = useState<"diff" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!path) return;
    getJSON<Comparable>(`/api/changed?path=${encodeURIComponent(path)}`)
      .then(setPair)
      .catch(() => setPair(null));
  }, [path]);

  useEffect(() => {
    // A render replaces the baseline, so last time's answer is about two files
    // that no longer exist as a pair.
    setDiff(null);
    setReview(null);
    setError(null);
    reload();
  }, [reload, renders]);

  async function run(kind: "diff" | "review") {
    setRunning(kind);
    onBusy(kind);
    setError(null);
    const done = await runJob(`/api/${kind}`, { path }, onLog);
    setRunning(null);
    onBusy(null);
    if (!done.ok) {
      setError(done.hint ? `${done.error} — ${done.hint}` : (done.error ?? "failed"));
      return;
    }
    if (kind === "diff") {
      setDiff(done.result as DiffResult);
      setReview(null);
    } else {
      const outcome = done.result as ReviewResult;
      setReview(outcome);
      setDiff(outcome.diff);
    }
  }

  if (!pair) return null;

  if (!pair.before) {
    return (
      <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-faint">
        {pair.why}
      </p>
    );
  }

  const report = diff;
  const working = running !== null;

  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-sm"
          disabled={busy || working}
          onClick={() => run("diff")}
          title="Compare this render with the one it replaced, frame by frame — no model needed"
        >
          {running === "diff" && <Spinner />}
          What changed?
        </button>
        {modelConfigured && (
          <button
            className="btn btn-sm btn-ghost"
            disabled={busy || working}
            onClick={() => run("review")}
            title="Compare, then have a model say what changed and whether the captions still match"
          >
            {running === "review" && <Spinner />}
            Review it
          </button>
        )}
        <span className="text-xs text-faint">
          against the render from{" "}
          {pair.at ? new Date(pair.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "earlier"}
        </span>
      </div>

      {!modelConfigured && (
        <p className="text-xs leading-relaxed text-faint">
          Comparing pixels needs nothing. Saying <em>what</em> changed needs a model —{" "}
          <Link href="/settings" className="text-brand underline-offset-2 hover:underline">
            configure one
          </Link>{" "}
          to have the captions checked against the screen too.
        </p>
      )}

      {error && <Banner tone="err">{error}</Banner>}

      {report && (
        <div role="status" aria-live="polite" className="space-y-2">
          {report.identical ? (
            <Banner tone="ok">
              Identical — this render is the same demo as the last one, frame for frame.
            </Banner>
          ) : (
            <>
              <p className="text-[13px] text-ink">
                <strong>
                  {report.ranges.length} change{report.ranges.length === 1 ? "" : "s"}
                </strong>{" "}
                · {share(report.changedFraction)} of the running time · length{" "}
                {report.durationBeforeMs === report.durationAfterMs
                  ? `${secs(report.durationAfterMs)}, unchanged`
                  : `${secs(report.durationBeforeMs)} → ${secs(report.durationAfterMs)}`}
              </p>
              <ul className="space-y-1.5">
                {report.ranges.slice(0, 8).map((r, i) => {
                  const finding = review?.findings.find((f) => f.startMs === r.startMs);
                  const badge = finding ? BADGE[finding.verdict] : null;
                  return (
                    <li key={i} className="rounded-lg border border-line bg-bg2 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        {badge && (
                          <span className={`tag ${badge.tone}`} title={badge.title}>
                            {badge.mark} {finding!.verdict}
                          </span>
                        )}
                        <span className="tabular-nums text-brand">
                          {secs(r.startMs)}–{secs(r.endMs)}
                        </span>
                        <span className="text-muted">{share(r.mean)} of pixels</span>
                        {r.beats.length > 0 && <span className="text-faint">{r.beats.join(", ")}</span>}
                        {r.truncated && <span className="text-warn">only in one render</span>}
                      </div>
                      {finding && (
                        <p className="mt-1 text-[13px] leading-relaxed text-ink">{finding.summary}</p>
                      )}
                      {finding?.verdict === "stale-caption" &&
                        finding.captions.map((c, j) => (
                          <p key={j} className="mt-1 text-xs italic text-faint">
                            caption: “{c}”
                          </p>
                        ))}
                      {report.strips[i] && (
                        /* Before / after / difference, as one image. The reason
                           `reel diff` writes these at all: a percentage does not
                           tell you which two pixels moved. */
                        <img
                          src={mediaUrl(report.strips[i]!)}
                          alt={`Before, after and the difference at ${secs(r.startMs)}`}
                          className="mt-2 w-full rounded-md border border-line"
                          loading="lazy"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
              {report.ranges.length > 8 && (
                <p className="text-xs text-faint">
                  {report.ranges.length - 8} further change
                  {report.ranges.length - 8 === 1 ? "" : "s"} not listed.
                </p>
              )}
            </>
          )}

          {review?.unconfigured && (
            <Banner tone="warn">
              Nothing judged these changes: {review.unconfigured} The pixel comparison above still
              stands — it just can&apos;t tell you what changed.
            </Banner>
          )}
          {review && !review.unconfigured && (
            <p className="text-xs text-faint">
              Judged by {review.model ?? "the configured model"}
              {review.skipped ? ` · ${review.skipped} further moments were beyond the budget` : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
