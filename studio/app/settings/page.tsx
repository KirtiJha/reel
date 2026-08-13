"use client";
import { useEffect, useState } from "react";
import { PageHead, Pill } from "@/components/bits";
import { getJSON, type ConfigInfo } from "@/lib/api";

export default function SettingsPage() {
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);

  useEffect(() => {
    getJSON<ConfigInfo>("/api/config").then(setCfg).catch(() => {});
  }, []);

  return (
    <div>
      <PageHead eyebrow="Settings" title="Environment" sub="Reel is provider-agnostic and BYO-key via a LiteLLM proxy. These are read from your environment." />

      <div className="grid grid-cols-2 gap-5 max-[860px]:grid-cols-1">
        <div className="card">
          <h2 className="mb-3 text-base font-semibold">Model (LiteLLM)</h2>
          {cfg === null ? (
            <div className="text-muted">Loading…</div>
          ) : cfg.llm.configured ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Pill tone="ok">connected</Pill>
              </div>
              <div className="text-muted">
                Model <span className="font-mono text-ink">{cfg.llm.model}</span>
              </div>
              <div className="text-muted">
                Proxy <span className="font-mono text-ink">{cfg.llm.host}</span>
              </div>
            </div>
          ) : (
            <div className="text-sm">
              <Pill tone="off">not configured</Pill>
              <p className="mt-3 text-muted">Set these environment variables (or a <span className="font-mono">.env</span>):</p>
              <pre className="mt-2 overflow-auto rounded-xl border border-line bg-[#07090f] p-3 font-mono text-[12px] text-muted">
{`LITELLM_API_BASE=https://your-proxy…
LITELLM_API_KEY=sk-…
LITELLM_MODEL=your-model-name
SSL_VERIFY=false   # corporate proxies`}
              </pre>
            </div>
          )}
          <p className="mt-4 border-t border-line pt-3 text-[12.5px] text-muted">
            Only <span className="font-mono text-ink">author</span> and subtitle localization
            require a model. <span className="font-mono text-ink">record</span>,{" "}
            <span className="font-mono text-ink">check</span> and{" "}
            <span className="font-mono text-ink">heal</span> all run offline — heal repairs a
            renamed id or a relabelled button on its own, and only asks a model about the cases
            its deterministic ladder can&apos;t settle.
          </p>
        </div>

        <div className="card">
          <h2 className="mb-3 text-base font-semibold">Subtitles &amp; localization</h2>
          {cfg && (
            <div className="mb-3 text-sm text-muted">
              Platform <span className="font-mono text-ink">{cfg.platform}</span>
            </div>
          )}
          <div className="text-sm text-muted">
            Captions render as sidecar <span className="font-mono text-ink">.srt</span> /{" "}
            <span className="font-mono text-ink">.vtt</span> — no extra setup. Localizing them into
            other languages uses the same LiteLLM proxy as authoring.
          </div>
        </div>
      </div>
    </div>
  );
}
