"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHead, Spinner } from "@/components/bits";
import { LogConsole } from "@/components/LogConsole";
import { getJSON, runJob, type ConfigInfo, type LogLine } from "@/lib/api";

export default function AuthorPage() {
  const [story, setStory] = useState("sign up, create a project, and invite a teammate");
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

  const disabled = running || !story.trim() || !url.trim() || cfg?.llm.configured === false;

  return (
    <div>
      <PageHead
        eyebrow="AI authoring"
        title="Describe it. Reel drives your app."
        sub="An agent opens your running app, works out the selectors, performs the story, and verifies each step — then emits a spec you own and edit. Add branches, terminal steps or a viewport matrix afterwards in Studio."
      />

      {cfg?.llm.configured === false && (
        <div className="card mb-5 border-warn/30 bg-warn/5">
          <div className="text-sm text-warn">No LLM configured.</div>
          <div className="mt-1 text-sm text-muted">
            Authoring is the one feature that needs a model. Recording, drift checks and
            self-healing all work without one — see{" "}
            <Link href="/settings" className="text-brand2">
              Settings
            </Link>
            .
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-5 max-[860px]:grid-cols-1">
        <div className="card">
          <label className="mb-4 block">
            <span className="label">The story to demo</span>
            <textarea
              className="input min-h-[110px] resize-y"
              value={story}
              onChange={(e) => setStory(e.target.value)}
              placeholder="sign up, create a project, invite a teammate"
            />
          </label>
          <label className="mb-4 block">
            <span className="label">App URL (already running)</span>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">Save spec to</span>
              <input className="input" value={out} onChange={(e) => setOut(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">Model (optional)</span>
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={cfg?.llm.model ?? "default"} />
            </label>
          </div>
          <button className="btn btn-primary mt-5 w-full" onClick={author} disabled={disabled}>
            {running ? <Spinner /> : "✨"} {running ? "Authoring…" : "Author demo"}
          </button>
        </div>

        <div className="card flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Agent progress</h2>
            {result && <span className="pill border-ok/30 bg-ok/10 text-ok"><span className="h-1.5 w-1.5 rounded-full bg-current" />done</span>}
          </div>
          <LogConsole lines={logs} running={running} />
          {error && <div className="mt-3 rounded-lg border border-err/30 bg-err/5 p-3 text-sm text-err">{error}</div>}
          {result && (
            <div className="mt-4 animate-fade-up">
              <div className="text-sm text-muted">
                Created <span className="font-mono text-brand2">{result.path}</span>
              </div>
              <pre className="mt-2 max-h-[220px] overflow-auto rounded-xl border border-line bg-[#07090f] p-3 font-mono text-[12px] text-muted">
                {result.raw}
              </pre>
              <Link href={`/studio?path=${encodeURIComponent(result.path)}`} className="btn btn-primary mt-3 w-full">
                Open in Studio →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
