"use client";
import { useEffect, useRef, useState } from "react";

export interface NavItem {
  href: string;
  label: string;
  external?: boolean;
}

/**
 * The landing page's navigation, below the width the inline row fits at.
 *
 * The row was simply hidden under 720px and nothing replaced it: on a phone the
 * page had no way to reach any of its own sections. A disclosure button is the
 * smallest honest fix — it is a real button, it says whether it is open, Escape
 * closes it, and a click outside does too.
 */
export function NavMenu({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={box} className="relative md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="site-nav-menu"
        aria-label={open ? "Close the menu" : "Open the menu"}
        onClick={() => setOpen((v) => !v)}
        className="btn btn-sm btn-ghost !px-2.5"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden
        >
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>
      {open && (
        <nav
          id="site-nav-menu"
          aria-label="Sections"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-xl border border-line2 bg-panel shadow-panel"
        >
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.href}>
                <a
                  href={i.href}
                  onClick={() => setOpen(false)}
                  {...(i.external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
                  className="block px-4 py-2.5 text-sm text-muted transition hover:bg-panel2 hover:text-ink"
                >
                  {i.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
