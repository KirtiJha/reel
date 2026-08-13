"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHead, Pill } from "@/components/bits";
import { getJSON, postJSON, type ConfigInfo } from "@/lib/api";

/**
 * What each command needs.
 *
 * The most common confusion about Reel is thinking a model is required to use
 * it at all. Only two things need one, so the page says which — plainly, in a
 * table, rather than in a paragraph people skim past.
 */
const CAPABILITIES = [
  { cmd: "record", needs: false, blurb: "Drive the app and render the media." },
  { cmd: "check", needs: false, blurb: "Re-run the spec in CI; fail on drift." },
  { cmd: "heal", needs: "partly", blurb: "Deterministic ladder first; a model only for what it can't settle." },
  { cmd: "author", needs: true, blurb: "Turn plain English into a spec you own." },
  { cmd: "subtitles", needs: "partly", blurb: "Captions are free; translating them needs a model." },
] as const;

export default function SettingsPage() {
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [form, setForm] = useState({ provider: "openai", model: "", baseUrl: "", apiKey: "" });
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const hydrate = useCallback((c: ConfigInfo) => {
    setCfg(c);
    // The key is deliberately absent from the response, so the field stays
    // empty and an unchanged save keeps whatever is already stored.
    setForm((f) => ({
      ...f,
      provider: c.providers?.find((p) => p.label === c.llm.provider)?.id ?? f.provider,
      model: c.llm.model ?? "",
      apiKey: "",
    }));
  }, []);

  useEffect(() => {
    getJSON<ConfigInfo>("/api/config").then(hydrate).catch(() => {});
  }, [hydrate]);

  async function save() {
    setBusy("save");
    setNote(null);
    try {
      const r = await postJSON<{ ok?: boolean; error?: string; hint?: string } & ConfigInfo>(
        "/api/llm-config",
        form,
      );
      if (r.error) {
        setNote({ ok: false, text: r.hint ? `${r.error} ${r.hint}` : r.error });
      } else {
        hydrate(r);
        setNote({ ok: true, text: "Saved. Test the connection to confirm it works." });
      }
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Could not save." });
    }
    setBusy(null);
  }

  async function testConnection() {
    setBusy("test");
    setNote(null);
    try {
      const r = await postJSON<{
        ok: boolean;
        provider?: string;
        model?: string;
        ms?: number;
        error?: string;
        hint?: string;
      }>("/api/llm-test", {});
      setNote(
        r.ok
          ? { ok: true, text: `${r.provider} answered as ${r.model} in ${r.ms} ms.` }
          : { ok: false, text: r.hint ? `${r.error} ${r.hint}` : (r.error ?? "Request failed.") },
      );
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Request failed." });
    }
    setBusy(null);
  }

  const connected = cfg?.llm.configured;
  // Providers whose endpoint is per-deployment can't have a useful default.
  const needsBaseUrl = ["litellm", "azure", "custom"].includes(form.provider);

  return (
    <div>
      <PageHead
        eyebrow="Settings"
        title="Environment"
        sub="Reel is provider-agnostic and bring-your-own-key. Pick a provider, point it at a model, and test it. Settings are written to this workspace's .env, which Reel reads on every run."
      />

      <div className="grid grid-cols-[1.15fr_1fr] gap-6 max-[1000px]:grid-cols-1">
        {/* ---- model ---- */}
        <div className="card">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-[15px] font-semibold">Model access</h2>
            {cfg === null ? (
              <span className="pill text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-faint" />
                checking…
              </span>
            ) : connected ? (
              <Pill tone="ok">connected</Pill>
            ) : (
              <Pill tone="off">not configured</Pill>
            )}
          </div>

          {cfg === null ? (
            <div className="text-[14px] text-muted">Loading…</div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="block">
                <span className="label">Provider</span>
                <select
                  className="input"
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                >
                  {(cfg.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="label flex items-baseline justify-between gap-3">
                  <span>Model</span>
                  <span className="font-normal text-faint">blank uses the provider default</span>
                </span>
                <input
                  className="input font-mono text-[13px]"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder="gpt-4o"
                />
              </label>

              <label className="block">
                <span className="label flex items-baseline justify-between gap-3">
                  <span>Endpoint URL</span>
                  <span className="font-normal text-faint">
                    {needsBaseUrl ? "required for this provider" : "optional override"}
                  </span>
                </span>
                <input
                  className="input font-mono text-[13px]"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                  placeholder="https://your-proxy.example.com"
                />
              </label>

              <label className="block">
                <span className="label flex items-baseline justify-between gap-3">
                  <span>API key</span>
                  <span className="font-normal text-faint">
                    {connected ? "leave blank to keep the current key" : "stored in .env, never shown again"}
                  </span>
                </span>
                <input
                  className="input font-mono text-[13px]"
                  type="password"
                  autoComplete="off"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={connected ? "••••••••" : "sk-…"}
                />
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-faint">
                  Optional if the provider&apos;s own key variable is already exported — an existing{" "}
                  <span className="font-mono">OPENAI_API_KEY</span> or{" "}
                  <span className="font-mono">ANTHROPIC_API_KEY</span> is enough on its own.
                </p>
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className="btn btn-brand btn-sm" disabled={busy !== null}>
                  {busy === "save" ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void testConnection()}
                  disabled={busy !== null || !connected}
                  title={connected ? "Send one real request to the provider" : "Save a configuration first"}
                >
                  {busy === "test" ? "Testing…" : "Test connection"}
                </button>
              </div>

              {note && (
                <div
                  className={`rounded-lg border px-3 py-2 text-[13px] leading-relaxed ${
                    note.ok
                      ? "border-ok/25 bg-ok/[0.07] text-ok"
                      : "border-err/30 bg-err/[0.07] text-err"
                  }`}
                >
                  {note.text}
                </div>
              )}

              <p className="text-[12.5px] leading-relaxed text-faint">
                Saved to <span className="font-mono">.env</span> in this workspace, which is
                git-ignored and written owner-only. Studio listens on localhost only. The key is
                write-only — it is never sent back to this page.
              </p>
            </form>
          )}
        </div>

        {/* ---- what needs a model ---- */}
        <div className="card">
          <h2 className="mb-1 text-[15px] font-semibold">What needs a model</h2>
          <p className="mb-4 text-[13.5px] leading-relaxed text-muted">
            Most of Reel runs entirely offline.
          </p>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {CAPABILITIES.map((c) => (
              <li key={c.cmd} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${
                    c.needs === true ? "bg-warn" : c.needs === "partly" ? "bg-brand" : "bg-ok"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[13px]">reel {c.cmd}</span>
                    <span
                      className={`flex-none text-[11px] font-semibold uppercase tracking-wider ${
                        c.needs === true
                          ? "text-warn"
                          : c.needs === "partly"
                            ? "text-brand"
                            : "text-ok"
                      }`}
                    >
                      {c.needs === true ? "needs one" : c.needs === "partly" ? "sometimes" : "offline"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{c.blurb}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6 max-[1000px]:grid-cols-1">
        <div className="card">
          <h2 className="mb-2 text-[15px] font-semibold">Subtitles &amp; localization</h2>
          <p className="text-[14px] leading-relaxed text-muted">
            Captions render as sidecar <span className="font-mono text-ink">.srt</span> /{" "}
            <span className="font-mono text-ink">.vtt</span> with no extra setup, so they work
            offline. Translating them into other languages goes through the same proxy as
            authoring.
          </p>
        </div>
        <div className="card">
          <h2 className="mb-2 text-[15px] font-semibold">Privacy</h2>
          <p className="text-[14px] leading-relaxed text-muted">
            Studio runs on your machine and reads the workspace you launched it from. Nothing is
            uploaded. Redaction and network mocking are applied before a frame is captured, so real
            data never reaches the rendered media.
          </p>
          <Link href="/gallery" className="btn btn-ghost btn-sm mt-4">
            Back to your demos
          </Link>
        </div>
      </div>
    </div>
  );
}
