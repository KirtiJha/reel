"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { getJSON, type ConfigInfo } from "@/lib/api";

const NAV = [
  {
    href: "/author",
    label: "Author",
    hint: "Describe a demo",
    icon: "M12 3l2.2 6.2L21 11l-6.8 1.8L12 19l-2.2-6.2L3 11l6.8-1.8z",
  },
  {
    href: "/studio",
    label: "Studio",
    hint: "Edit and render",
    icon: "M4 5h16v11H4zM8 20h8M12 16v4",
  },
  {
    href: "/gallery",
    label: "Gallery",
    hint: "Every demo here",
    icon: "M3 5h8v6H3zM13 5h8v6h-8zM3 13h8v6H3zM13 13h8v6h-8z",
  },
  {
    href: "/settings",
    label: "Settings",
    hint: "Model and env",
    icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V10a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);

  useEffect(() => {
    getJSON<ConfigInfo>("/api/config")
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const configured = cfg?.llm.configured;

  return (
    <aside className="sticky top-0 flex h-screen flex-col gap-7 border-r border-line bg-gradient-to-b from-panel/50 to-bg/10 px-3.5 py-6 max-[900px]:static max-[900px]:h-auto max-[900px]:flex-row max-[900px]:flex-wrap max-[900px]:items-center max-[900px]:gap-4">
      {/* Home is the landing page — the only way back out of the workspace. */}
      <Link
        href="/"
        className="group flex items-center gap-3 rounded-xl px-2 py-1.5 transition hover:bg-panel"
        title="Back to the overview"
      >
        <div className="rounded-[9px] shadow-glow transition group-hover:brightness-110">
          <Logo size={32} />
        </div>
        <div>
          <div className="text-[19px] font-bold leading-none tracking-tight">Reel</div>
          <div className="mt-1 text-[11px] text-faint">Lights, camera, code.</div>
        </div>
      </Link>

      <nav className="flex flex-col gap-0.5 max-[900px]:flex-row max-[900px]:flex-wrap">
        {NAV.map((n) => {
          const active = pathname === n.href || pathname?.startsWith(`${n.href}/`);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition ${
                active ? "bg-brand-soft text-ink" : "text-muted hover:bg-panel hover:text-ink"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-r bg-brand2 max-[900px]:hidden" />
              )}
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`flex-none transition ${active ? "text-brand2" : "text-faint group-hover:text-muted"}`}
              >
                <path d={n.icon} />
              </svg>
              <span className="flex-1">{n.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto max-[900px]:mt-0">
        {cfg === null ? (
          <span className="pill w-full justify-center text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-faint" />
            checking…
          </span>
        ) : configured ? (
          <div
            className="rounded-xl border border-ok/25 bg-ok/[0.07] px-3 py-2.5 max-[900px]:py-1.5"
            title={cfg.llm.host}
          >
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-ok" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-ok">
                Model ready
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-muted" title={cfg.llm.model}>
              {cfg.llm.model}
            </div>
          </div>
        ) : (
          <Link
            href="/settings"
            className="block rounded-xl border border-warn/25 bg-warn/[0.07] px-3 py-2.5 transition hover:border-warn/40"
          >
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-warn" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-warn">
                No model
              </span>
            </div>
            <div className="mt-1 text-[11px] leading-snug text-muted">
              Recording still works — authoring needs one.
            </div>
          </Link>
        )}
      </div>
    </aside>
  );
}
