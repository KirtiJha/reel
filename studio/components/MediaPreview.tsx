"use client";
import { useState } from "react";
import { mediaUrl } from "@/lib/api";

const ext = (p: string) => p.slice(p.lastIndexOf(".")).toLowerCase();

export function MediaPreview({ outputs }: { outputs: string[] }) {
  const [mode, setMode] = useState<"video" | "interactive">("video");
  if (!outputs.length) return null;

  const mp4 = outputs.find((o) => ext(o) === ".mp4");
  const webm = outputs.find((o) => ext(o) === ".webm");
  const gif = outputs.find((o) => ext(o) === ".gif");
  const vtt = outputs.find((o) => ext(o) === ".vtt");
  const html = outputs.find((o) => ext(o) === ".html");
  const video = mp4 || webm;
  // With no video or GIF, the interactive build is the only thing to show.
  const showing = html && (mode === "interactive" || (!video && !gif)) ? "interactive" : "video";

  return (
    <div className="animate-fade-up">
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
          {video ? (
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
        <a
          href={mediaUrl(html)}
          target="_blank"
          rel="noreferrer"
          className="btn btn-sm btn-ghost mt-3"
        >
          Open full size ↗
        </a>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {outputs.map((o) => (
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
      </div>
    </div>
  );
}
