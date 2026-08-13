"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState, Field, PageHead, Spinner } from "@/components/bits";
import { LogConsole } from "@/components/LogConsole";
import { getJSON, runJob, type ConfigInfo, type LogLine } from "@/lib/api";

/**
 * Starting points for the story field.
 *
 * A blank prompt is the hardest thing to answer. These are the flows people
 * actually demo, phrased the way the agent reads best — a sequence of user
 * actions, not a description of the UI.
 */
const EXAMPLES = [
  "sign up, create a project, and invite a teammate",
  "search the catalogue, open a product, and add it to the cart",
  "upload a CSV, map the columns, and run the import",
  "open the dashboard, filter to last 30 days, and export a report",
];

export default function AuthorPage() {
  const [story, setStory] = useState(EXAMPLES[0]!);
  const [url, setUrl] = useState("http://localhost:3000");
  const [out, setOut] = useState("demo.reel.yaml");
  const [model, setModel] = useState("");
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ path: string; raw: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJSON<ConfigInfo>("/api/config").then(setCfg).catch(() => {});
  }, []);

  async function author() {
    setRunning(true);
    setLogs([]);
    setResult(null);
    setError(null);
    const done = await runJob(
      "/api/author",
      { story, url, out, model: model || undefined },
      (l) => setLogs((p) => [...p, l]),
    );
    setRunning(false);
    if (done.ok) setResult(done.result);
    else setError(done.hint ? `${done.error} — ${done.hint}` : done.error ?? "failed");
  }

  const noModel = cfg?.llm.configured === false;
  const disabled = running || !story.trim() || !url.trim() || noModel;

  return (
    <div>
      <PageHead
        eyebrow="AI authoring"
        title="Describe it. Reel drives your app."
        sub="An agent opens your running app, works out the selectors, performs the story and verifies each step — then emits a spec you own and edit. Add branches, terminal steps or a viewport matrix afterwards in Studio."
      />

      {noModel && (
        <div className="card mb-6 border-warn/25 bg-warn/[0.06]">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full bg-warn/15 text-[13px] text-warn">
              !
            </span>
            <div>
              <div className="text-sm font-semibold text-warn">No model configured</div>
              <div className="mt-1 text-sm leading-relaxed text-muted">
                Authoring is the one feature that needs one. Recording, drift checks and
                self-healing all work without a model —{" "}
                <Link href="/settings" className="text-brand2 underline-offset-2 hover:underline">
                  set one up in Settings
                </Link>
                .
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 max-[1000px]:grid-cols-1">
        {/* ---- the brief ---- */}
        <div className="card flex flex-col gap-5">
          <Field label="The story to demo" hint="plain English, in order">
            <textarea
              className="input min-h-[104px] resize-y leading-relaxed"
              value={story}
              onChange={(e) => setStory(e.target.value)}
              placeholder="sign up, create a project, invite a teammate"
            />
          </Field>

          <div>
            <div className="label">Or start from one of these</div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  onClick={() => setStory(e)}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] transition ${
                    story === e
                      ? "border-brand/40 bg-brand-soft text-ink"
                      : "border-line bg-bg2 text-muted hover:border-line2 hover:text-ink"
                  }`}
                >
                  {e.length > 46 ? `${e.slice(0, 44)}…` : e}
                </button>
              ))}
            </div>
          </div>

          <Field label="App URL" hint="must already be running">
            <input
              className="input font-mono text-[13px]"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3000"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <Field label="Save spec to">
              <input
                className="input font-mono text-[13px]"
                value={out}
                onChange={(e) => setOut(e.target.value)}
              />
            </Field>
            <Field label="Model" hint="optional">
              <input
                className="input font-mono text-[13px]"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={cfg?.llm.model ?? "default"}
              />
            </Field>
          </div>

          <button className="btn btn-brand w-full" onClick={author} disabled={disabled}>
            {running ? (
              <>
                <Spinner /> Authoring…
              </>
            ) : (
              "Author demo"
            )}
          </button>
          <p className="-mt-2 text-[12.5px] leading-relaxed text-faint">
            The agent drives a real browser against that URL. Nothing is uploaded — the model only
            sees what your proxy sends it.
          </p>
        </div>

        {/* ---- what the agent is doing ---- */}
        <div className="card flex min-h-[420px] flex-col">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">Agent progress</h2>
            {running && (
              <span className="pill border-brand/30 bg-brand/10 text-brand2">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                working
              </span>
            )}
            {result && (
              <span className="pill border-ok/30 bg-ok/10 text-ok">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                done
              </span>
            )}
          </div>

          {logs.length === 0 && !running && !result && !error ? (
            <EmptyState
              icon="M12 3l2.2 6.2L21 11l-6.8 1.8L12 19l-2.2-6.2L3 11l6.8-1.8z"
              title="Nothing running yet"
              sub="Describe the story and hit Author. You'll see each step the agent takes — the selector it settled on, and whether the step verified."
            />
          ) : (
            <LogConsole lines={logs} running={running} />
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-err/30 bg-err/[0.07] p-3.5 text-sm leading-relaxed text-err">
              {error}
            </div>
          )}

          {result && (
            <div className="mt-4 animate-fade-up">
              <div className="text-sm text-muted">
                Created <span className="font-mono text-brand2">{result.path}</span>
              </div>
              <pre className="mt-2 max-h-[240px] overflow-auto rounded-xl border border-line bg-[#07090f] p-3.5 font-mono text-[12px] leading-relaxed text-muted">
                {result.raw}
              </pre>
              <Link
                href={`/studio?path=${encodeURIComponent(result.path)}`}
                className="btn btn-brand mt-3 w-full"
              >
                Open in Studio →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
