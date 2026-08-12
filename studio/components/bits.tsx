"use client";
import type { ReactNode } from "react";

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
}) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-[23px] w-[40px] flex-none rounded-full transition ${
          checked ? "bg-brand" : "bg-line2"
        }`}
      >
        <span
          className={`absolute top-[2.5px] h-[18px] w-[18px] rounded-full bg-white transition-all ${
            checked ? "left-[19px]" : "left-[2.5px]"
          }`}
        />
      </button>
      {label && <span className="text-sm">{label}</span>}
    </label>
  );
}

export function Pill({ tone = "muted", children }: { tone?: "muted" | "ok" | "off"; children: ReactNode }) {
  const styles = {
    muted: "text-muted",
    ok: "text-ok border-ok/30 bg-ok/10",
    off: "text-warn border-warn/30 bg-warn/10",
  }[tone];
  return (
    <span className={`pill ${styles}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-[#0a0d13]" />
  );
}

export function PageHead({ eyebrow, title, sub }: { eyebrow?: string; title: string; sub?: string }) {
  return (
    <div className="mb-7 animate-fade-up">
      {eyebrow && (
        <div className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-faint">{eyebrow}</div>
      )}
      <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
      {sub && <p className="mt-1 max-w-[62ch] text-muted">{sub}</p>}
    </div>
  );
}
