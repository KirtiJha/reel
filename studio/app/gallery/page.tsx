"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHead } from "@/components/bits";
import { getJSON, mediaUrl, type GallerySpec } from "@/lib/api";

export default function GalleryPage() {
  const [specs, setSpecs] = useState<GallerySpec[] | null>(null);

  useEffect(() => {
    getJSON<{ specs: GallerySpec[] }>("/api/gallery").then((d) => setSpecs(d.specs)).catch(() => setSpecs([]));
  }, []);

  return (
    <div>
      <PageHead eyebrow="Gallery" title="Your demos" sub="Every spec in this workspace and its rendered media. Click to open in Studio." />

      {specs === null ? (
        <div className="text-muted">Loading…</div>
      ) : specs.length === 0 ? (
        <div className="card text-center text-muted">
          No specs found here yet.{" "}
          <Link href="/author" className="text-brand2">
            Author one →
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-[18px]">
          {specs.map((s) => {
            const video = s.outputs.find((o) => o.kind === "mp4" || o.kind === "webm");
            const gif = s.outputs.find((o) => o.kind === "gif");
            // An interactive-only spec has been rendered — it just has no poster.
            const interactiveOnly = !video && !gif && s.outputs.some((o) => o.kind === "html");
            // A matrix render produces the same kinds many times over; count
            // them instead of printing a wall of identical tags.
            const kinds = [...s.outputs.reduce((m, o) => m.set(o.kind, (m.get(o.kind) ?? 0) + 1), new Map<string, number>())];
            return (
              <Link
                key={s.path}
                href={`/studio?path=${encodeURIComponent(s.path)}`}
                className="group overflow-hidden rounded-2xl border border-line bg-panel transition hover:-translate-y-0.5 hover:border-line2"
              >
                <div className="grid aspect-[16/10] place-items-center overflow-hidden bg-[#05070c]">
                  {video ? (
                    <video className="h-full w-full object-cover" muted loop playsInline preload="metadata" src={mediaUrl(video.path)} onMouseOver={(e) => e.currentTarget.play()} onMouseOut={(e) => e.currentTarget.pause()} />
                  ) : gif ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="h-full w-full object-cover" alt="" src={mediaUrl(gif.path)} />
                  ) : interactiveOnly ? (
                    <span className="text-sm text-brand2">interactive build ↗</span>
                  ) : (
                    <span className="text-sm text-faint">not rendered yet</span>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="text-[15px] font-semibold">{s.name}</h3>
                  <div className="mt-0.5 truncate font-mono text-[12px] text-faint">{s.path}</div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {s.kind === "terminal" && (
                      <span className="tag !border-warn/40 !text-warn" title="Runs real commands">
                        terminal
                      </span>
                    )}
                    {s.branchCount > 0 && (
                      <span
                        className="tag !border-brand/40 !text-brand"
                        title="The viewer picks a path in the interactive build"
                      >
                        {s.branchCount} branch{s.branchCount > 1 ? "es" : ""}
                      </span>
                    )}
                    {s.variants > 1 && (
                      <span className="tag !border-brand/40 !text-brand" title="Viewport × theme matrix">
                        {s.variants} variants
                      </span>
                    )}
                    {s.stepCount > 0 && <span className="tag">{s.stepCount} steps</span>}
                  </div>

                  {kinds.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {kinds.map(([kind, n]) => (
                        <span
                          key={kind}
                          className={kind === "html" ? "tag border-brand/40 text-brand2" : "tag"}
                        >
                          {kind}
                          {n > 1 ? ` ×${n}` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
