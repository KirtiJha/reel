"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Banner, Field, PageHead, Spinner } from "@/components/bits";
import { LogConsole } from "@/components/LogConsole";
import { getJSON, postJSON, runJob, type ConfigInfo, type LogLine } from "@/lib/api";

/**
 * How to get a first spec.
 *
 * Studio used to have exactly one door in, and it was the one that needs an API
 * key: the Gallery's empty state sent you to Author, which refuses to run
 * without a model. Two of the three ways Reel can make a spec need no key at
 * all, and neither of them was reachable from the UI. This page puts all three
 * side by side and leads with the ones that always work.
 */

type Route = "init" | "capture" | "author";

const ROUTES: { id: Route; title: string; blurb: string; needsKey: boolean; cmd: string }[] = [
  {
    id: "init",
    title: "Start from a template",
    blurb:
      "Writes a commented demo.reel.yaml you can read in one sitting, with the common steps listed and switched off. Nothing runs, nothing opens — you get a file to edit.",
    needsKey: false,
    cmd: "reel init",
  },
  {
    id: "capture",
    title: "Author by doing",
    blurb:
      "Opens your app in a real browser. Demo it the way you would to a customer, add captions and beats from the toolbar, press Finish — and the spec you get back already replays.",
    needsKey: false,
    cmd: "reel capture --url <url>",
  },
  {
    id: "author",
    title: "Describe it in English",
    blurb:
      "An agent opens your running app, works out the selectors, performs the story and verifies each step. The only route that needs a model.",
    needsKey: true,
    cmd: "reel author <story>",
  },
];

export default function NewDemoPage() {
  const [route, setRoute] = useState<Route>("init");
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);

  // init
  const [dir, setDir] = useState(".");
  const [name, setName] = useState("My demo");
  const [url, setUrl] = useState("http://localhost:3000");
  // capture
  const [out, setOut] = useState("demo.reel.yaml");

  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<{ path: string; steps?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJSON<ConfigInfo>("/api/config").then(setCfg).catch(() => {});
  }, []);

  async function scaffold() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await postJSON<{ ok: boolean; path?: string; error?: string; hint?: string }>(
        "/api/init",
        { dir, name, url },
      );
      if (!r.ok || !r.path) setError(r.hint ? `${r.error} ${r.hint}` : (r.error ?? "Failed."));
      else setResult({ path: r.path });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    }
    setBusy(false);
  }

  async function startCapture() {
    setBusy(true);
    setError(null);
    setResult(null);
    setLogs([]);
    const done = await runJob("/api/capture", { url, out, name }, (l) => setLogs((p) => [...p, l]));
    setBusy(false);
    if (!done.ok) setError(done.hint ? `${done.error} — ${done.hint}` : (done.error ?? "Failed."));
    else setResult({ path: done.result?.path, steps: done.result?.steps });
  }

  const noModel = cfg?.llm.configured === false;

  return (
    <div>
      <PageHead
        eyebrow="New demo"
        title="Three ways to a spec"
        sub="A spec is a short YAML file describing the demo. Two of these need nothing but Reel itself — only the last one wants a model."
        actions={
          <Link href="/gallery" className="btn btn-sm btn-ghost">
            Back to the gallery
          </Link>
        }
      />

      <ul className="grid gap-5 md:grid-cols-3">
        {ROUTES.map((r) => {
          const active = route === r.id && !r.needsKey;
          const blocked = r.needsKey && noModel;
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[15px] font-semibold">{r.title}</h2>
                <span
                  className={`tag flex-none ${
                    blocked
                      ? "!border-warn/40 !text-warn"
                      : r.needsKey
                        ? "!border-brand/40 !text-brand"
                        : "!border-ok/40 !text-ok"
                  }`}
                >
                  {r.needsKey ? "needs a model" : "no key"}
                </span>
              </div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{r.blurb}</p>
              <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-[#07090f] px-2.5 py-1.5 font-mono text-[12px] text-brand2">
                {r.cmd}
              </div>
            </>
          );
          const cls = `card block h-full w-full text-left transition ${
            active ? "border-brand/50 shadow-panel" : "hover:border-line2"
          }`;
          return (
            <li key={r.id} className="contents">
              {/* A link where it navigates, a button where it switches the form
                  below — never an anchor nested inside a button. */}
              {r.needsKey ? (
                <Link href={blocked ? "/settings" : "/author"} className={cls}>
                  {body}
                  <span className="mt-3 block text-[13px] font-semibold text-brand2">
                    {blocked ? "Set up a model →" : "Open the authoring page →"}
                  </span>
                </Link>
              ) : (
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRoute(r.id)}
                  className={cls}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="card flex flex-col gap-5">
          {route === "init" ? (
            <>
              <h2 className="text-[15px] font-semibold">Start from a template</h2>
              <Field label="Where to put it" hint="relative to this workspace">
                <input
                  className="input font-mono text-[13px]"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="."
                />
              </Field>
              <Field label="Demo name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="App URL" hint="you can change it later">
                <input
                  className="input font-mono text-[13px]"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </Field>
              <button className="btn btn-brand w-full" onClick={scaffold} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner /> Writing…
                  </>
                ) : (
                  "Create demo.reel.yaml"
                )}
              </button>
              <p className="-mt-2 text-[12.5px] leading-relaxed text-faint">
                The same file <code>reel init</code> writes. It refuses to overwrite one that is
                already there.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-[15px] font-semibold">Author by doing</h2>
              <Field label="App URL" hint="must already be running">
                <input
                  className="input font-mono text-[13px]"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://localhost:3000"
                />
              </Field>
              <Field label="Save spec to">
                <input
                  className="input font-mono text-[13px]"
                  value={out}
                  onChange={(e) => setOut(e.target.value)}
                />
              </Field>
              <Field label="Demo name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <button
                className="btn btn-brand w-full"
                onClick={startCapture}
                disabled={busy || !url.trim()}
              >
                {busy ? (
                  <>
                    <Spinner /> Recording your session…
                  </>
                ) : (
                  "Open my app and capture"
                )}
              </button>
              <p className="-mt-2 text-[12.5px] leading-relaxed text-faint">
                A browser window opens <em className="not-italic text-muted">on this machine</em> —
                Studio only ever listens to localhost, so the window is yours. Press Finish in its
                toolbar, or close it, and the spec is written. If Studio is running somewhere you
                can&apos;t see a window, run it from a terminal instead:
              </p>
              <div className="overflow-x-auto rounded-lg border border-line bg-[#07090f] px-3 py-2 font-mono text-[12px] text-brand2">
                reel capture --url {url || "<url>"} -o {out || "demo.reel.yaml"}
              </div>
            </>
          )}

          {error && <Banner tone="err">{error}</Banner>}

          {result?.path && (
            <div className="animate-fade-up">
              <Banner tone="ok">
                Created <span className="font-mono">{result.path}</span>
                {typeof result.steps === "number" ? ` — ${result.steps} steps captured.` : "."}
              </Banner>
              <Link
                href={`/studio?path=${encodeURIComponent(result.path)}`}
                className="btn btn-brand mt-3 w-full"
              >
                Open in Studio →
              </Link>
            </div>
          )}
        </div>

        <div className="card flex min-h-[320px] flex-col">
          <h2 className="mb-4 text-[15px] font-semibold">
            {route === "capture" ? "Capture log" : "What happens next"}
          </h2>
          {route === "capture" ? (
            <LogConsole lines={logs} running={busy} label="Capture log" />
          ) : (
            <ol className="space-y-3 text-[13.5px] leading-relaxed text-muted">
              <li>
                <span className="font-semibold text-ink">1. Edit the steps.</span> The template lists
                the common ones — <code>click</code>, <code>type</code>, <code>waitFor</code>,{" "}
                <code>caption</code> — commented out. Uncomment what your demo does.
              </li>
              <li>
                <span className="font-semibold text-ink">2. Record it.</span> Studio drives your real
                app and renders the media. No key needed for any of it.
              </li>
              <li>
                <span className="font-semibold text-ink">3. Keep it honest.</span> Check drift re-runs
                the spec headlessly and fails when a step stops working — the same command CI runs.
              </li>
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
