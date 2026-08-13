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

export function PageHead({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  /** Right-aligned controls that belong to the page as a whole. */
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex items-start justify-between gap-6 animate-fade-up max-[720px]:flex-col max-[720px]:gap-4">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em]">{title}</h1>
        {sub && <p className="mt-2 max-w-[68ch] text-[15px] leading-relaxed text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * What a panel shows before it has anything to show.
 *
 * An empty dark rectangle reads as broken; saying what will appear here, and
 * what to do to make it appear, reads as ready.
 */
export function EmptyState({
  icon,
  title,
  sub,
  children,
}: {
  icon?: string;
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line2 px-6 py-12 text-center">
      {icon && (
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mb-3 text-faint"
        >
          <path d={icon} />
        </svg>
      )}
      <div className="text-[15px] font-medium text-muted">{title}</div>
      {sub && <p className="mt-1.5 max-w-[46ch] text-[13.5px] leading-relaxed text-faint">{sub}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** A labelled group of controls inside a card. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label flex items-baseline justify-between gap-3">
        <span>{label}</span>
        {hint && <span className="font-normal text-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
