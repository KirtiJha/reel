"use client";
import { useEffect, useRef } from "react";
import type { LogLine } from "@/lib/api";

const cls: Record<string, string> = {
  step: "text-[#9fc0ff]",
  ok: "text-ok",
  warn: "text-warn",
  error: "text-err",
  phase: "text-[#c9a6ff] font-bold mt-1.5",
  info: "text-muted",
  debug: "text-faint",
};
const sym: Record<string, string> = { step: "→", ok: "✓", warn: "!", error: "✗", info: "›", debug: "", phase: "" };

export function LogConsole({ lines, running }: { lines: LogLine[]; running?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, running]);

  return (
    <div
      ref={ref}
      className="max-h-[360px] min-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-[#07090f] p-4 font-mono text-[12.5px] leading-relaxed"
    >
      {lines.length === 0 && !running && <span className="text-faint">Logs will stream here…</span>}
      {lines.map((l, i) => (
        <div key={i} className={cls[l.level] ?? "text-muted"}>
          {sym[l.level] ? <span className="mr-2 opacity-70">{sym[l.level]}</span> : null}
          {l.msg}
        </div>
      ))}
      {running && (
        <div className="mt-2 flex items-center gap-2 text-faint">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand2" /> working…
        </div>
      )}
    </div>
  );
}
