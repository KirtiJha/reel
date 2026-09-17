"use client";
import { useId, useRef, type ReactNode } from "react";

export function Toggle({
  checked,
  onChange,
  label,
  labelledBy,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  /**
   * The id of the element that names this switch, for the common case where the
   * name is a heading in a sibling block rather than text beside the control.
   * Without it a screen reader announces "switch, on" and nothing else — which
   * is what every toggle in the Output tab used to do.
   */
  labelledBy?: string;
  /** The id of the explanatory copy under that heading. */
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-[23px] w-[40px] flex-none rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
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

/* --------------------------------- tabs --------------------------------- */

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  /** Announced in place of `label` when the visible label is decorative. */
  title?: string;
}

/**
 * A tab strip that behaves like one.
 *
 * Four strips in this app were rows of plain buttons: every one of them was a
 * separate tab stop, none announced itself as a tab, and none told anyone which
 * of them was selected. The ARIA pattern asks for one tab stop for the whole
 * strip, arrows to move between tabs, and Home/End for the ends — so that is
 * what this does, once, rather than five times badly.
 *
 * `idBase` links each tab to its panel. Render the panel with
 * `role="tabpanel"`, `id={panelId(idBase, active)}` and
 * `aria-labelledby={tabId(idBase, active)}` — `TabPanel` below does both.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  idBase,
  className = "",
  variant = "solid",
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  /** What this strip switches between, for anyone who can't see the layout. */
  label: string;
  idBase: string;
  className?: string;
  /** `solid` fills the selected tab; `soft` tints it. */
  variant?: "solid" | "soft";
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    onChange(id);
    // Selection follows focus, so focus has to actually move with it.
    refs.current[id]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={className}>
      {tabs.map((t) => {
        const selected = t.id === active;
        const on =
          variant === "solid" ? "bg-brand text-[#0a0d13]" : "bg-brand-soft text-ink";
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, t.id)}
            aria-selected={selected}
            aria-controls={panelId(idBase, t.id)}
            tabIndex={selected ? 0 : -1}
            title={t.title}
            onClick={() => onChange(t.id)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
              selected ? on : "text-muted hover:bg-panel2 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

/** The panel half of the pattern, wired to the tab that names it. */
export function TabPanel({
  idBase,
  active,
  className = "",
  children,
}: {
  idBase: string;
  active: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={panelId(idBase, active)}
      aria-labelledby={tabId(idBase, active)}
      // Focusable so a keyboard user can reach a scrollable panel's content
      // after leaving the strip.
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}

/**
 * A result banner. `alert` for a failure so it interrupts; `status` for a
 * success so it doesn't. Both are live regions, which is the whole point:
 * a render that failed used to change only pixels.
 */
export function Banner({
  tone,
  children,
  className = "",
}: {
  tone: "ok" | "err" | "warn";
  children: ReactNode;
  className?: string;
}) {
  const styles = {
    ok: "border-ok/25 bg-ok/[0.07] text-ok",
    err: "border-err/30 bg-err/[0.07] text-err",
    warn: "border-warn/30 bg-warn/[0.07] text-warn",
  }[tone];
  return (
    <div
      role={tone === "err" ? "alert" : "status"}
      aria-live={tone === "err" ? "assertive" : "polite"}
      className={`rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${styles} ${className}`}
    >
      {children}
    </div>
  );
}

/** A checkbox that looks like the rest of the app. */
export function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 flex-none cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-50"
      />
      <label htmlFor={id} className="cursor-pointer select-none">
        <span className="text-sm">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-relaxed text-faint">{hint}</span>}
      </label>
    </div>
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
    <div className="mb-8 flex flex-col items-start justify-between gap-4 animate-fade-up sm:flex-row sm:gap-6">
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
