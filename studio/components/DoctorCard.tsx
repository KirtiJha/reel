"use client";
import { useEffect, useState } from "react";
import { getJSON, type DoctorReport } from "@/lib/api";

/**
 * The preflight, where it can still save someone a render.
 *
 * A missing ffmpeg or an unusable browser is the most common way a first run
 * fails, and it used to surface as one red line at the bottom of a job that had
 * already spent two minutes driving the app. `reel doctor` has always known
 * this before anything is recorded; this puts the answer where the person is
 * about to press Record.
 *
 * It says nothing when the machine is fine — a green banner every session is
 * noise, and noise is what makes the red one easy to miss. A warning (no model,
 * no voice key) is dismissible and stays dismissed for the session; a hard
 * failure is not, because there is nothing to dismiss it in favour of.
 */
const DISMISS_KEY = "reel.doctor.dismissed";

export function DoctorCard() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until read

  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      // Private windows and blocked site data both throw here; showing the
      // card is the safe side of that.
      setDismissed(false);
    }
    getJSON<DoctorReport>("/api/doctor").then(setReport).catch(() => setReport(null));
  }, []);

  if (!report) return null;

  const failed = report.checks.filter((c) => c.status === "fail");
  const warned = report.checks.filter((c) => c.status === "warn");
  if (!failed.length && !warned.length) return null;
  // A warning can be waved off; a failure means nothing will render at all.
  if (!failed.length && dismissed) return null;

  const tone = failed.length
    ? { border: "border-err/30", bg: "bg-err/[0.07]", text: "text-err", dot: "bg-err" }
    : { border: "border-warn/25", bg: "bg-warn/[0.07]", text: "text-warn", dot: "bg-warn" };
  const shown = failed.length ? failed : warned;

  return (
    <div
      role={failed.length ? "alert" : "status"}
      aria-live="polite"
      className={`card mb-5 ${tone.border} ${tone.bg}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className={`text-sm font-semibold ${tone.text}`}>
            {failed.length
              ? `This machine can't record yet — ${failed.length} check${failed.length > 1 ? "s" : ""} failed`
              : `${warned.length} optional thing${warned.length > 1 ? "s are" : " is"} not set up`}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {failed.length
              ? "Recording needs these. Fixing them here is faster than finding out at the end of a render."
              : "Everything needed to record works. These only affect the features that use them."}
          </p>
          <ul className="mt-3 space-y-2">
            {shown.map((c) => (
              <li key={c.name} className="flex items-start gap-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 flex-none rounded-full ${tone.dot}`} />
                <div className="min-w-0">
                  <span className="text-[13px] font-medium text-ink">{c.name}</span>
                  <span className="text-[13px] text-muted"> — {c.detail}</span>
                  {c.fix && (
                    <div className="mt-1 overflow-x-auto rounded-md border border-line bg-[#07090f] px-2.5 py-1.5 font-mono text-[12px] text-brand2">
                      {c.fix}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
        {!failed.length && (
          <button
            className="btn btn-sm btn-ghost flex-none"
            onClick={() => {
              setDismissed(true);
              try {
                sessionStorage.setItem(DISMISS_KEY, "1");
              } catch {
                /* nothing to remember it in; it will come back next load */
              }
            }}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
