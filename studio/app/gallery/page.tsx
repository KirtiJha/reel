"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState, PageHead } from "@/components/bits";
import { getJSON, mediaUrl, type GallerySpec } from "@/lib/api";

type Filter = "all" | "web" | "terminal" | "unrendered";

export default function GalleryPage() {
  const [specs, setSpecs] = useState<GallerySpec[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  // A render that died halfway leaves a zero-byte file behind. Preferring the
  // GIF for the still is right until the GIF is the broken one, so a failure
  // demotes it and the tile falls back to the video.
  const [broken, setBroken] = useState<Set<string>>(new Set());

  useEffect(() => {
    getJSON<{ specs: GallerySpec[] }>("/api/gallery")
      .then((d) => setSpecs(d.specs))
      .catch(() => setSpecs([]));
  }, []);

  const rendered = (s: GallerySpec) => s.outputs.length > 0;

  const shown = useMemo(() => {
    const list = specs ?? [];
    const needle = q.trim().toLowerCase();
    return list.filter((s) => {
      if (filter === "web" && s.kind !== "web") return false;
      if (filter === "terminal" && s.kind !== "terminal") return false;
      if (filter === "unrendered" && rendered(s)) return false;
      if (!needle) return true;
      return `${s.name} ${s.path}`.toLowerCase().includes(needle);
    });
  }, [specs, filter, q]);

  const counts = useMemo(() => {
    const list = specs ?? [];
    return {
      all: list.length,
      web: list.filter((s) => s.kind === "web").length,
      terminal: list.filter((s) => s.kind === "terminal").length,
      unrendered: list.filter((s) => !rendered(s)).length,
    };
  }, [specs]);

  return (
    <div>
      <PageHead
        eyebrow="Gallery"
        title="Your demos"
        sub="Every spec in this workspace and whatever it last rendered. Open one to record, check or heal it."
        actions={
          <Link href="/author" className="btn btn-brand btn-sm">
            New demo
          </Link>
        }
      />

      {specs !== null && specs.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["all", "All"],
                ["web", "Web"],
                ["terminal", "Terminal"],
                ["unrendered", "Not rendered"],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                  filter === id
                    ? "bg-brand-soft text-ink"
                    : "text-muted hover:bg-panel hover:text-ink"
                }`}
              >
                {label}
                <span className="ml-1.5 text-[11px] text-faint">{counts[id]}</span>
              </button>
            ))}
          </div>
          <input
            className="input ml-auto !w-[240px] !py-1.5 text-[13px]"
            placeholder="Filter by name or path…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}

      {specs === null ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="overflow-hidden rounded-2xl border border-line bg-panel">
              <div className="aspect-[16/10] animate-pulse bg-bg2" />
              <div className="space-y-2 p-4">
                <div className="h-4 w-2/3 animate-pulse rounded bg-bg2" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-bg2" />
              </div>
            </div>
          ))}
        </div>
      ) : specs.length === 0 ? (
        <EmptyState
          icon="M4 5h16v14H4zM4 10h16"
          title="No specs in this workspace yet"
          sub="A spec is a short YAML file describing the demo. Describe one in plain English and let an agent write it for you."
        >
          <Link href="/author" className="btn btn-brand">
            Author your first demo
          </Link>
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing matches that filter" sub="Try a different search or category." />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5 stagger">
          {shown.map((s) => {
            const video = s.outputs.find((o) => o.kind === "mp4" || o.kind === "webm");
            const gifRaw = s.outputs.find((o) => o.kind === "gif");
            const gif = gifRaw && !broken.has(gifRaw.path) ? gifRaw : undefined;
            const stillRaw = s.outputs.find((o) => o.kind === "png");
            const still = stillRaw && !broken.has(stillRaw.path) ? stillRaw : undefined;
            const interactiveOnly =
              !video && !gif && !still && s.outputs.some((o) => o.kind === "html");
            const kinds = [
              ...s.outputs.reduce(
                (m, o) => m.set(o.kind, (m.get(o.kind) ?? 0) + 1),
                new Map<string, number>(),
              ),
            ];
            return (
              <Link
                key={s.path}
                href={`/studio?path=${encodeURIComponent(s.path)}`}
                className="group overflow-hidden rounded-2xl border border-line bg-panel transition duration-200 hover:-translate-y-1 hover:border-line2 hover:shadow-panel"
              >
                <div className="relative grid aspect-[16/10] place-items-center overflow-hidden bg-[#05070c]">
                  {gif ? (
                    // A GIF paints its first frame immediately, so it makes a
                    // better still than a video element waiting on metadata.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="h-full w-full object-cover"
                      alt=""
                      loading="lazy"
                      src={mediaUrl(gif.path)}
                      onError={() => setBroken((b) => new Set(b).add(gif.path))}
                    />
                  ) : video ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video
                      className="h-full w-full object-cover"
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      // #t=0.1 makes the browser decode and paint a frame; without
                      // it the tile is a black rectangle until someone presses play.
                      src={`${mediaUrl(video.path)}#t=0.1`}
                      onMouseOver={(e) => void e.currentTarget.play().catch(() => {})}
                      onMouseOut={(e) => e.currentTarget.pause()}
                    />
                  ) : still ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      className="h-full w-full object-cover"
                      alt=""
                      loading="lazy"
                      src={mediaUrl(still.path)}
                      onError={() => setBroken((b) => new Set(b).add(still.path))}
                    />
                  ) : interactiveOnly ? (
                    <span className="text-sm text-brand2">interactive build ↗</span>
                  ) : (
                    <div className="text-center">
                      <div className="text-sm text-faint">not rendered yet</div>
                      <div className="mt-1 text-[12px] text-faint/70">Open to record it</div>
                    </div>
                  )}
                  {video && gif && (
                    <span className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/70 backdrop-blur">
                      video
                    </span>
                  )}
                </div>
                <div className="p-4">
                  <h3 className="text-[15px] font-semibold leading-snug transition group-hover:text-brand2">
                    {s.name}
                  </h3>
                  <div className="mt-1 truncate font-mono text-[11.5px] text-faint">{s.path}</div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
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
                    {kinds.map(([kind, n]) => (
                      <span
                        key={kind}
                        className={kind === "html" ? "tag !border-brand/40 !text-brand2" : "tag"}
                      >
                        {kind}
                        {n > 1 ? ` ×${n}` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
