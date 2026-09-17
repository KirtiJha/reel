"use client";
import { useId, useState } from "react";
import { postJSON } from "@/lib/api";

/**
 * The media library.
 *
 * Drop a file in and it lands in the spec's own directory, referenced by path.
 * Paste a URL and Studio downloads it *now*, into that same directory — so the
 * render still only ever reads local files, and the picture is committed and
 * reviewed like any other input.
 *
 * The distinction that makes this safe is *when*: fetching while you edit is a
 * decision a person just made, and the file it produces is visible in a diff.
 * Fetching while you render would put a server's uptime between a spec and its
 * output, which is the byte-identical promise gone.
 */
export function MediaLibrary({
  path,
  busy,
  onAdded,
}: {
  path: string;
  busy: boolean;
  onAdded: (relPath: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "err">("ok");
  const [over, setOver] = useState(false);
  const [working, setWorking] = useState(false);
  const inputId = useId();
  const urlId = useId();

  async function add(body: Record<string, unknown>) {
    setWorking(true);
    setNote(null);
    try {
      const r = await postJSON<{ path?: string; error?: string }>("/api/asset", { path, ...body });
      if (r.error || !r.path) throw new Error(r.error ?? "failed");
      setTone("ok");
      setNote(`Added ${r.path}`);
      onAdded(r.path);
    } catch (err) {
      setTone("err");
      setNote((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function addFiles(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      // Base64 rather than multipart: the API server speaks JSON everywhere
      // else, and a demo asset is a logo or a diagram, not a video.
      const data = await file.arrayBuffer().then(toBase64);
      await add({ name: file.name, data });
    }
  }

  const disabled = busy || working || !path;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) void addFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border border-dashed px-4 py-6 text-center transition ${
          over ? "border-brand bg-brand/[0.06]" : "border-line bg-bg2"
        }`}
      >
        <p className="text-[13px] text-muted">Drop an image here</p>
        <p className="mt-1 text-xs text-faint">
          It lands in <code>assets/</code> beside the spec, and is committed with it.
        </p>
        {/* `display:none` on the input took the only control here out of the
            tab order entirely — the label was not focusable either, so the drop
            zone was the whole feature and it was mouse-only. Clipped rather
            than hidden keeps the input focusable, and `peer` puts the focus
            ring on the button the user can actually see. The input comes first
            because `peer-*` only reaches later siblings. */}
        <input
          id={inputId}
          type="file"
          accept="image/*"
          className="peer sr-only"
          disabled={disabled}
          onChange={(e) => void addFiles(e.target.files)}
        />
        <label
          htmlFor={inputId}
          className="btn btn-sm btn-ghost mt-3 inline-block cursor-pointer peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand"
        >
          Choose a file
        </label>
      </div>

      <div className="flex gap-2">
        <label htmlFor={urlId} className="sr-only">
          Image URL to download into the spec&apos;s directory
        </label>
        <input
          id={urlId}
          className="input flex-1"
          placeholder="…or paste an image URL"
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) void add({ url: url.trim() }).then(() => setUrl(""));
          }}
        />
        <button
          className="btn btn-sm"
          disabled={disabled || !url.trim()}
          onClick={() => void add({ url: url.trim() }).then(() => setUrl(""))}
        >
          Download
        </button>
      </div>

      {note && (
        <p
          role={tone === "err" ? "alert" : "status"}
          aria-live="polite"
          className={`text-[13px] ${tone === "err" ? "text-err" : "text-ok"}`}
        >
          {note}
        </p>
      )}
      <p className="text-xs leading-relaxed text-faint">
        Downloading happens now, while you are editing — never while rendering. A render reads
        local files only, which is what keeps two runs of a spec byte-identical.
      </p>
    </div>
  );
}

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte image blows
  // the argument limit and throws where a plain loop simply works.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
