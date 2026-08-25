"use client";
import { useEffect, useMemo, useState } from "react";
import { mediaUrl } from "@/lib/api";

const ext = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();
const MEDIA = new Set([".mp4", ".webm", ".gif", ".html", ".srt", ".vtt", ".png", ".jpg", ".m4a"]);

/**
 * Group a matrix render into its variants.
 *
 * A matrix spec writes `demo-{viewport}-{theme}.gif`, so a run produces several
 * files that are the *same demo* rather than several artifacts of one. Showing
 * them as a flat list of links buries that; a switcher makes it obvious.
 */
function groupVariants(outputs: string[]): { name: string; files: string[] }[] {
  const stems = outputs.map((o) => o.replace(/\.[^./]+$/, ""));
  // The shared prefix across every output is the demo; what follows identifies
  // the variant. With one variant this yields a single group.
  const byStem = new Map<string, string[]>();
  outputs.forEach((o, i) => {
    const stem = stems[i]!;
    byStem.set(stem, [...(byStem.get(stem) ?? []), o]);
  });
  const groups = [...byStem.entries()].map(([stem, files]) => ({
    name: stem.split("/").pop() || stem,
    files,
  }));
  if (groups.length < 2) return [{ name: "", files: outputs }];

  // Trim the common leading text so the labels read "desktop-dark", not
  // "taskflow-demo-desktop-dark".
  const names = groups.map((g) => g.name);
  let prefix = 0;
  while (prefix < names[0]!.length && names.every((n) => n[prefix] === names[0]![prefix])) prefix++;
  return groups.map((g) => ({ ...g, name: g.name.slice(prefix).replace(/^[-_.]+/, "") || g.name }));
}

export function MediaPreview({ outputs }: { outputs: string[] }) {
  const playable = useMemo(() => outputs.filter((o) => MEDIA.has(ext(o))), [outputs]);
  const variants = useMemo(() => groupVariants(playable), [playable]);
  const [variant, setVariant] = useState(0);
  const [mode, setMode] = useState<"video" | "interactive">("video");

  useEffect(() => setVariant(0), [outputs]);

  if (!playable.length) return null;
  const files = variants[Math.min(variant, variants.length - 1)]?.files ?? playable;

  // A spec can write the bare narration mix alongside the video, for editing
  // elsewhere. On its own it is still worth hearing, so it gets a player rather
  // than an empty panel.
  const audio = files.find((o) => ext(o) === ".m4a");
  const mp4 = files.find((o) => ext(o) === ".mp4");
  const webm = files.find((o) => ext(o) === ".webm");
  const gif = files.find((o) => ext(o) === ".gif");
  const vtt = files.find((o) => ext(o) === ".vtt");
  const html = files.find((o) => ext(o) === ".html");
  const video = mp4 || webm;
  // With no video or GIF, the interactive build is the only thing to show.
  const showing = html && (mode === "interactive" || (!video && !gif)) ? "interactive" : "video";
  // Directories (a storyboard) can't be served as media — link them separately.
  const extras = outputs.filter((o) => !MEDIA.has(ext(o)));

  return (
    <div className="animate-fade-up">
      {variants.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-faint">Variant</span>
          {variants.map((v, i) => (
            <button
              key={v.name || i}
              onClick={() => setVariant(i)}
              className={`rounded-lg border px-2.5 py-1 text-[12px] font-medium transition ${
                i === variant
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-line text-muted hover:text-ink"
              }`}
            >
              {v.name || `variant ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      {html && (video || gif) && (
        <div className="mb-3 inline-flex rounded-xl border border-line bg-bg2 p-1">
          {(["video", "interactive"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                showing === m ? "bg-brand text-[#0a0d13]" : "text-muted hover:text-ink"
              }`}
            >
              {m === "video" ? "Video" : "Interactive"}
            </button>
          ))}
        </div>
      )}

      {showing === "interactive" && html ? (
        <div className="overflow-hidden rounded-xl border border-line bg-black">
          <iframe
            title="Interactive demo"
            src={mediaUrl(html)}
            className="block h-[560px] w-full border-0"
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-black">
          {!video && !gif && audio ? (
            <div className="p-4">
              <audio controls className="w-full" src={mediaUrl(audio)} />
              <div className="mt-2 text-xs text-faint">
                The mixed soundtrack on its own — narration, bed and effects.
              </div>
            </div>
          ) : video ? (
            <video controls playsInline className="block w-full" src={mediaUrl(video)}>
              {vtt && <track kind="subtitles" src={mediaUrl(vtt)} default label="Captions" />}
            </video>
          ) : gif ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="demo" className="block w-full" src={mediaUrl(gif)} />
          ) : null}
        </div>
      )}

      {showing === "interactive" && html && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a href={mediaUrl(html)} target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost">
            Open full size ↗
          </a>
          <span className="text-xs text-faint">
            Click the stage or use ← → to step. Branch choices appear inline.
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {files.map((o) => (
          <a
            key={o}
            href={mediaUrl(o)}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-line px-2.5 py-1.5 font-mono text-[12px] text-brand2 hover:border-brand2"
          >
            {o.split("/").pop()}
          </a>
        ))}
        {extras.map((o) => (
          <span
            key={o}
            title="A folder of images — open it from disk"
            className="rounded-lg border border-dashed border-line px-2.5 py-1.5 font-mono text-[12px] text-faint"
          >
            {o.split("/").pop()}/
          </span>
        ))}
      </div>
    </div>
  );
}
