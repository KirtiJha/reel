"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { getJSON, type ConfigInfo } from "@/lib/api";

const NAV = [
  { href: "/author", label: "Author", icon: "M12 3v18M5 10l7-7 7 7" }, // arrow-up (create)
  { href: "/studio", label: "Studio", icon: "M4 5h16v11H4zM8 20h8M12 16v4" }, // monitor
  { href: "/gallery", label: "Gallery", icon: "M3 5h8v6H3zM13 5h8v6h-8zM3 13h8v6H3zM13 13h8v6h-8z" },
  { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l1.5 2.6-2 3.4h-3l-2.5 1.5L10.5 22h-3L5 20.5 3 17l1.5-2.6" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);

  useEffect(() => {
    getJSON<ConfigInfo>("/api/config").then(setCfg).catch(() => setCfg(null));
  }, []);

  const configured = cfg?.llm.configured;

  return (
    <aside className="sticky top-0 flex h-screen flex-col gap-6 border-r border-line bg-gradient-to-b from-panel/60 to-bg/20 px-4 py-6 max-[860px]:static max-[860px]:h-auto max-[860px]:flex-row max-[860px]:flex-wrap max-[860px]:items-center">
      <Link href="/author" className="flex items-center gap-3 px-1.5">
        <div className="rounded-[9px] shadow-glow">
          <Logo size={34} />
        </div>
        <div>
          <div className="text-[20px] font-bold leading-none tracking-tight">Reel</div>
          <div className="mt-0.5 text-[11.5px] text-muted">Lights, camera, code.</div>
        </div>
      </Link>

      <nav className="flex flex-col gap-1 max-[860px]:flex-row max-[860px]:flex-wrap">
        {NAV.map((n) => {
          const active = pathname === n.href || (n.href !== "/" && pathname?.startsWith(n.href));
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-[14.5px] font-medium transition ${
                active ? "bg-brand-soft text-ink" : "text-muted hover:bg-panel hover:text-ink"
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={active ? "text-brand2" : "text-faint"}>
                <path d={n.icon} />
              </svg>
              {n.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto px-1.5 max-[860px]:mt-0">
        {cfg === null ? (
          <span className="pill text-muted"><span className="h-1.5 w-1.5 rounded-full bg-faint" />checking…</span>
        ) : configured ? (
          <span className="pill border-ok/30 bg-ok/10 text-ok" title={cfg.llm.host}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {cfg.llm.model}
          </span>
        ) : (
          <Link href="/settings" className="pill border-warn/30 bg-warn/10 text-warn">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            No LLM configured
          </Link>
        )}
      </div>
    </aside>
  );
}
