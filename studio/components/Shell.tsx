"use client";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LocalOnly } from "./LocalOnly";
import { Sidebar } from "./Sidebar";

/**
 * Set on the public marketing build. The same codebase serves two surfaces —
 * one deployed as a static site, one launched by `reel ui` — so the workspace
 * routes need somewhere to say "this part runs locally" rather than shipping
 * as a shell that fails on its first API call.
 */
const PUBLIC_SITE = process.env.NEXT_PUBLIC_REEL_SITE === "1";

/**
 * Chooses the frame the current route renders in.
 *
 * The landing page is a different kind of surface from the app: full-bleed,
 * its own rhythm, no chrome competing with the hero. Everything else is a
 * workspace and wants the sidebar. Routing that decision here keeps the root
 * layout a server component and leaves each page free of layout concerns —
 * including the public-site case, which no page has to know about.
 */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const marketing = pathname === "/";

  if (marketing) return <>{children}</>;
  if (PUBLIC_SITE) return <LocalOnly />;

  return (
    <div className="grid min-h-screen grid-cols-[248px_1fr] max-[900px]:grid-cols-1">
      <Sidebar />
      <main className="w-full px-8 pb-20 pt-8 max-[900px]:px-5">
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
