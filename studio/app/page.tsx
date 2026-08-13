"use client";
import Link from "next/link";
import { useState } from "react";
import { Carousel } from "@/components/Carousel";
import { GitHubLink } from "@/components/GitHubLink";
import { Logo } from "@/components/Logo";
import { DOCS_URL, ISSUES_URL, REPO_URL, SPEC_DOCS_URL } from "@/lib/site";

/**
 * The landing page.
 *
 * Someone arriving here has not decided to use Reel yet, so the page has to
 * answer "what is this" before it offers anything to click. It leads with the
 * artifact — a real recorded demo, rendered by the tool itself — because for a
 * tool whose whole output is video, showing beats describing.
 */

/** Output formats one spec can produce, each with real media rendered by Reel. */
const FORMATS = [
  {
    id: "gif",
    label: "GIF",
    blurb: "Lightweight loop for a README or a chat thread.",
    src: "/demo/taskflow.gif",
    type: "img" as const,
  },
  {
    id: "mp4",
    label: "MP4",
    blurb: "Crisp video for docs, social, and embeds.",
    src: "/demo/taskflow.mp4",
    type: "video" as const,
  },
  {
    id: "terminal",
    label: "Terminal",
    blurb: "Film a CLI with the same grammar. Commands really run.",
    src: "/demo/cli.gif",
    type: "img" as const,
  },
  {
    id: "storyboard",
    label: "Storyboard",
    blurb: "One still per beat — for slides, issues, and PR descriptions.",
    src: "/demo/storyboard.png",
    type: "img" as const,
  },
];

const FEATURES = [
  {
    title: "One spec, every format",
    body: "GIF, MP4, WebM, storyboard stills and a self-contained interactive build — all from the same file. No re-recording per channel.",
    icon: "M4 6h16M4 12h16M4 18h10",
  },
  {
    title: "It never goes stale",
    body: "reel check re-runs the demo headlessly in CI and fails the build when a step can't complete. A broken flow is a red build, not a wrong GIF nobody noticed.",
    icon: "M20 6L9 17l-5-5",
  },
  {
    title: "Self-healing selectors",
    body: "When the UI drifts, a deterministic ladder re-resolves the step — and only asks a model about the cases it genuinely can't settle. Your spec gets repaired, not just reported.",
    icon: "M12 3v3m0 12v3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M3 12h3m12 0h3",
  },
  {
    title: "Describe it in English",
    body: "reel author opens your running app, works out the selectors, performs the story and verifies each step — then emits a spec you own and edit. Bring your own key.",
    icon: "M12 3l2.2 6.2L21 11l-6.8 1.8L12 19l-2.2-6.2L3 11l6.8-1.8z",
  },
  {
    title: "Byte-identical renders",
    body: "A virtual timeline and a frozen clock mean the same spec produces the same bytes on any machine. Committed demo media changes only when the demo does.",
    icon: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
  {
    title: "Safe by construction",
    body: "Redact selectors, mock network calls, and freeze dates before a frame is captured — so a customer name never reaches a public GIF.",
    icon: "M12 3l8 4v6c0 4.4-3.4 8-8 9-4.6-1-8-4.6-8-9V7z",
  },
];

/** Every command the CLI exposes, worded as `reel --help` words them. */
const COMMANDS = [
  { cmd: "init", blurb: "Scaffold a starter demo.reel.yaml to edit." },
  { cmd: "record <spec>", blurb: "Drive your app from a spec and render the demo." },
  { cmd: "check <spec>", blurb: "Re-run the spec headlessly and fail if any step can't complete." },
  { cmd: "heal <spec>", blurb: "Re-resolve a step the UI broke, and repair the spec in place." },
  { cmd: "author <story>", blurb: "Turn plain English into a spec an agent verified against your app." },
  { cmd: "ui", blurb: "Launch Reel Studio, the local web workspace." },
];

/* Condensed from this repo's own workflow — Reel keeps its own demos honest
   the same way it would keep yours. */
const CI = `- run: npm ci
- run: npx playwright install --with-deps chromium

# Fails the build when a step can't complete.
- name: Drift check
  run: npx reel check demo.reel.yaml

# Deterministic, so this is a no-op unless
# the demo genuinely changed.
- name: Regenerate demo media
  run: npx reel record demo.reel.yaml`;

/** Studio screenshots, in the order someone would actually meet the app. */
const SHOTS = [
  {
    src: "/demo/studio-author.png",
    title: "Author",
    blurb: "Describe the story in plain English; an agent drives your app and writes the spec.",
  },
  {
    src: "/demo/studio-studio.png",
    title: "Studio",
    blurb: "The spec, the render controls and the rendered result on one screen.",
  },
  {
    src: "/demo/studio-output.png",
    title: "Output & polish",
    blurb: "Preset, device frame, pacing and deterministic rendering — written back into the spec.",
  },
  {
    src: "/demo/studio-gallery.png",
    title: "Gallery",
    blurb: "Every spec in the workspace, with whatever it last rendered.",
  },
];

const SPEC = `name: TaskFlow — add and complete a task
url: http://localhost:4321

polish:
  zoom: auto
  frame: browser

steps:
  - caption: "Capture work in a snap"
  - type: { selector: "#task-input", text: "Ship the demo" }
  - click: role=button[name=Add]
  - waitFor: text=Ship the demo
  - click: text=Ship the demo
  - beat: done

output:
  preset: share
  gif: out/demo.gif
  mp4: out/demo.mp4
  storyboard: out/storyboard`;

/**
 * True on the deployed marketing build.
 *
 * The same page serves two audiences: a visitor who has never installed Reel,
 * and someone who already ran `reel ui` and reached it locally. Only the calls
 * to action differ — a stranger needs the install command, a local user
 * already has the app one click away.
 */
const PUBLIC_SITE = process.env.NEXT_PUBLIC_REEL_SITE === "1";
const INSTALL = "npx @kirtijha/reel init && npx @kirtijha/reel ui";

function PrimaryCta({ size = "" }: { size?: string }) {
  const [copied, setCopied] = useState(false);
  if (!PUBLIC_SITE) {
    return (
      <Link href="/author" className={`btn btn-brand ${size}`}>
        Author a demo
      </Link>
    );
  }
  return (
    <button
      className={`btn btn-brand ${size} font-mono`}
      onClick={() => {
        void navigator.clipboard
          .writeText(INSTALL)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          // Clipboard access can be blocked; the command is visible either way.
          .catch(() => {});
      }}
      title="Copy the install command"
    >
      {copied ? "Copied" : INSTALL}
    </button>
  );
}

export default function Landing() {
  const [format, setFormat] = useState(FORMATS[0]!);

  return (
    <div className="min-h-screen">
      {/* ---------- nav ---------- */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-bg/70 backdrop-blur-xl">
        <div className="page flex items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <Logo size={30} />
            <span className="text-[17px] font-bold tracking-tight">Reel</span>
          </div>
          <nav className="flex items-center gap-1 text-sm max-[720px]:hidden">
            <a href="#how" className="rounded-lg px-3 py-2 text-muted transition hover:text-ink">
              How it works
            </a>
            <a href="#features" className="rounded-lg px-3 py-2 text-muted transition hover:text-ink">
              Features
            </a>
            <a href="#start" className="rounded-lg px-3 py-2 text-muted transition hover:text-ink">
              Quickstart
            </a>
            <a href="#cli" className="rounded-lg px-3 py-2 text-muted transition hover:text-ink">
              CLI
            </a>
            <a href="#studio" className="rounded-lg px-3 py-2 text-muted transition hover:text-ink">
              Studio
            </a>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="rounded-lg px-3 py-2 text-muted transition hover:text-ink"
            >
              Docs
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <GitHubLink compact />
            {PUBLIC_SITE ? (
              <a href="#start" className="btn btn-brand btn-sm">
                Get started →
              </a>
            ) : (
              <Link href="/author" className="btn btn-brand btn-sm">
                Open Studio →
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />
        <div className="page relative px-6 pb-6 pt-20 text-center max-[720px]:pt-12">
          <div className="stagger">
            <div>
              <span className="pill border-brand/25 bg-brand/10 text-brand2">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                Open source · MIT · runs locally and in CI
              </span>
            </div>
            <h1 className="mx-auto mt-6 max-w-[19ch] text-[62px] font-bold leading-[1.04] tracking-[-0.03em] max-[720px]:text-[38px]">
              Demos as code, <span className="grad-text">for web apps and CLIs</span>
            </h1>
            <p className="prose-muted mx-auto mt-6 max-w-[64ch] text-[17px]">
              Describe the demo or script it. Reel drives your <em className="not-italic text-ink">real</em>{" "}
              app, records it, and renders a polished GIF, video, storyboard or interactive
              walkthrough — then fails your build the moment the flow breaks.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <PrimaryCta size="btn-lg" />
              {PUBLIC_SITE ? (
                <a href="#how" className="btn btn-ghost btn-lg">
                  See how it works
                </a>
              ) : (
                <Link href="/gallery" className="btn btn-ghost btn-lg">
                  Browse the gallery
                </Link>
              )}
            </div>
            <div className="mt-5 font-mono text-[13px] text-faint">
              <span className="text-muted">$</span> npx @kirtijha/reel record demo.reel.yaml
            </div>
          </div>
        </div>

        {/* The artifact itself, front and centre. */}
        <div className="page relative px-6 pb-20 pt-10">
          <div className="overflow-hidden rounded-[20px] border border-line bg-panel shadow-panel">
            <div className="flex items-center gap-2 border-b border-line bg-bg2 px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-[12px] text-faint">
                out/hero.mp4 — rendered by Reel from a 20-line spec
              </span>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              className="block w-full"
              src="/demo/hero.mp4"
              autoPlay
              muted
              loop
              playsInline
            />
          </div>
        </div>
      </section>

      {/* ---------- spec → output ---------- */}
      <section id="how" className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="text-center">
            <div className="eyebrow">The whole idea</div>
            <h2 className="mt-3 text-[38px] font-bold tracking-[-0.02em] max-[720px]:text-[28px]">
              A short spec in, polished media out
            </h2>
            <p className="prose-muted mx-auto mt-3 max-w-[60ch]">
              The spec lives next to your code and is reviewed like code. Change the app, re-run
              the spec, commit the new media.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-6 max-[900px]:grid-cols-1">
            <div className="card overflow-hidden !p-0">
              <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <span className="font-mono text-[12px] text-muted">demo.reel.yaml</span>
                <span className="tag">input</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.65] text-muted">
                {SPEC}
              </pre>
            </div>

            <div className="card !p-0">
              <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5">
                {FORMATS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f)}
                    className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
                      format.id === f.id
                        ? "bg-brand-soft text-ink"
                        : "text-muted hover:bg-panel2 hover:text-ink"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
                <span className="tag ml-auto">output</span>
              </div>
              <div className="grid place-items-center bg-[#05070c] p-4">
                {format.type === "video" ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    key={format.id}
                    className="w-full rounded-lg"
                    src={format.src}
                    autoPlay
                    muted
                    loop
                    playsInline
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={format.id}
                    className="w-full rounded-lg"
                    alt={format.label}
                    src={format.src}
                  />
                )}
              </div>
              <p className="px-5 py-4 text-[13.5px] text-muted">{format.blurb}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- three steps ---------- */}
      <section className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="grid grid-cols-3 gap-6 max-[900px]:grid-cols-1">
            {[
              {
                n: "01",
                t: "Write it, or describe it",
                b: "Hand-write the spec, or tell an agent the story in plain English and let it work out the selectors against your running app.",
              },
              {
                n: "02",
                t: "Record",
                b: "Reel drives the real app in a real browser — zooming toward what matters, easing a cursor, laying captions over the top.",
              },
              {
                n: "03",
                t: "Commit, then keep it honest",
                b: "Check the media in beside your code. reel check runs the same spec in CI and fails the moment the flow stops working.",
              },
            ].map((s) => (
              <div key={s.n} className="card">
                <div className="font-mono text-[13px] font-bold text-brand2">{s.n}</div>
                <h3 className="mt-3 text-[19px] font-semibold tracking-tight">{s.t}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{s.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- features ---------- */}
      <section id="features" className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="text-center">
            <div className="eyebrow">What you get</div>
            <h2 className="mt-3 text-[38px] font-bold tracking-[-0.02em] max-[720px]:text-[28px]">
              Built for demos that outlive the sprint
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-3 gap-5 max-[1000px]:grid-cols-2 max-[720px]:grid-cols-1">
            {FEATURES.map((f) => (
              <div key={f.title} className="card-interactive">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-soft">
                  <svg
                    width="19"
                    height="19"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-brand2"
                  >
                    <path d={f.icon} />
                  </svg>
                </div>
                <h3 className="mt-4 text-[16.5px] font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>


      {/* ---------- the point: it lands in your README ---------- */}
      <section className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="grid grid-cols-2 items-center gap-10 max-[900px]:grid-cols-1">
            <div>
              <div className="eyebrow">Where it ends up</div>
              <h2 className="mt-3 text-[38px] font-bold tracking-[-0.02em] max-[720px]:text-[30px]">
                One line in your README
              </h2>
              <p className="prose-muted mt-4">
                The render writes straight into your repo, so embedding it is a normal markdown
                image — no upload, no share link, no account, nothing to expire.
              </p>
              <div className="mt-6 overflow-hidden rounded-xl border border-line bg-[#07090f]">
                <div className="border-b border-line px-4 py-2 font-mono text-[11.5px] text-faint">
                  README.md
                </div>
                <pre className="overflow-x-auto p-4 font-mono text-[13px] text-muted">
                  ![Demo](docs/demo.gif)
                </pre>
              </div>
              <p className="mt-5 text-[14px] leading-relaxed text-muted">
                And because <span className="font-mono text-ink">reel check</span> runs the same
                spec in CI, the image stops being a screenshot someone forgot to update — a broken
                flow fails the build instead.
              </p>
            </div>

            <div className="overflow-hidden rounded-2xl border border-line bg-[#05070c]">
              <div className="flex items-center gap-2 border-b border-line bg-bg2 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                <span className="ml-3 font-mono text-[12px] text-faint">your-project / README.md</span>
              </div>
              <div className="p-6">
                <div className="text-[22px] font-bold tracking-tight">TaskFlow</div>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
                  Capture work in a snap. Add a task, complete it, move on.
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="mt-4 w-full rounded-lg border border-line"
                  alt="A Reel-rendered demo embedded in a README"
                  src="/demo/taskflow.gif"
                  loading="lazy"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- quickstart ---------- */}
      <section id="start" className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="text-center">
            <div className="eyebrow">Quickstart</div>
            <h2 className="mt-3 text-[38px] font-bold tracking-[-0.02em] max-[720px]:text-[28px]">
              Recording in about a minute
            </h2>
            <p className="prose-muted mx-auto mt-3 max-w-[58ch]">
              Node 20+, and an app already running somewhere you can reach.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-3 gap-5 max-[900px]:grid-cols-1">
            {[
              {
                n: "1",
                t: "Scaffold a spec",
                cmd: "npx @kirtijha/reel init",
                b: "Writes a starter demo.reel.yaml you can read in one sitting.",
              },
              {
                n: "2",
                t: "Point it at your app",
                cmd: "$EDITOR demo.reel.yaml",
                b: "Set url:, then list the steps — click, type, waitFor, caption.",
              },
              {
                n: "3",
                t: "Render it",
                cmd: "npx @kirtijha/reel record demo.reel.yaml",
                b: "GIF, MP4 and a storyboard land in out/, ready to commit.",
              },
            ].map((s) => (
              <div key={s.n} className="card">
                <div className="font-mono text-[13px] font-bold text-brand2">{s.n}</div>
                <h3 className="mt-3 text-[17px] font-semibold tracking-tight">{s.t}</h3>
                <div className="mt-3 overflow-x-auto rounded-lg border border-line bg-[#07090f] px-3 py-2 font-mono text-[12.5px] text-brand2">
                  {s.cmd}
                </div>
                <p className="mt-3 text-[14px] leading-relaxed text-muted">{s.b}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener" className="btn btn-brand">
              Read the docs
            </a>
            <a
              href={SPEC_DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="btn btn-ghost"
            >
              See a full spec
            </a>
          </div>
        </div>
      </section>

      {/* ---------- cli ---------- */}
      <section id="cli" className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="text-center">
            <div className="eyebrow">The CLI</div>
            <h2 className="mt-3 text-[38px] font-bold tracking-[-0.02em] max-[720px]:text-[28px]">
              It all runs from your terminal
            </h2>
            <p className="prose-muted mx-auto mt-3 max-w-[62ch]">
              Studio is optional. The CLI is the whole tool — the same six commands work on your
              machine and on a CI runner, with no service to sign up for.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-2 gap-6 max-[900px]:grid-cols-1">
            <div className="card !p-0">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                <span className="ml-3 font-mono text-[12px] text-faint">reel --help</span>
              </div>
              <ul className="divide-y divide-line">
                {COMMANDS.map((c) => (
                  <li key={c.cmd} className="px-5 py-3">
                    <div className="font-mono text-[13px] text-brand2">reel {c.cmd}</div>
                    <div className="mt-1 text-[13.5px] leading-relaxed text-muted">{c.blurb}</div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-6">
              <div className="card !p-0">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <span className="font-mono text-[12px] text-muted">.github/workflows/reel.yml</span>
                  <span className="tag">in CI</span>
                </div>
                <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-[1.7] text-muted">
                  {CI}
                </pre>
              </div>
              <div className="card">
                <h3 className="text-[15px] font-semibold">Why it belongs in CI</h3>
                <p className="mt-2 text-[14px] leading-relaxed text-muted">
                  <span className="font-mono text-ink">check</span> fails the build the moment a step
                  can&apos;t complete, so a broken flow is a red build rather than a misleading GIF.
                  And because renders are deterministic,{" "}
                  <span className="font-mono text-ink">record</span> is a no-op unless the demo
                  genuinely changed — a media diff means something really moved.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- studio ---------- */}
      <section id="studio" className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="text-center">
            <div className="eyebrow">Reel Studio</div>
            <h2 className="mt-3 text-[38px] font-bold tracking-[-0.02em] max-[720px]:text-[28px]">
              A local workspace for your demos
            </h2>
            <p className="prose-muted mx-auto mt-3 max-w-[62ch]">
              Everything the CLI does, with the spec, the controls and the rendered result on one
              screen. Runs on your machine — nothing is uploaded anywhere.
            </p>
          </div>

          <div className="mt-12">
            <Carousel shots={SHOTS} />
          </div>
        </div>
      </section>

      {/* ---------- cta ---------- */}
      <section className="border-t border-white/[0.05] py-24">
        <div className="page px-6">
          <div className="card sheen relative overflow-hidden text-center !p-14">
            <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />
            <div className="relative">
              <h2 className="text-[36px] font-bold tracking-[-0.02em] max-[720px]:text-[26px]">
                Record your first demo
              </h2>
              <p className="prose-muted mx-auto mt-3 max-w-[52ch]">
                Point Reel at an app you already have running. You'll have a spec and a rendered
                demo in a couple of minutes.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <PrimaryCta size="btn-lg" />
                {PUBLIC_SITE ? (
                  <a href="#features" className="btn btn-ghost btn-lg">
                    What you get
                  </a>
                ) : (
                  <Link href="/studio" className="btn btn-ghost btn-lg">
                    Open a spec
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/[0.05] py-10">
        <div className="page flex flex-wrap items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-2.5">
            <Logo size={22} />
            <span className="text-sm font-semibold">Reel</span>
            <span className="text-sm text-faint">— Lights, camera, code.</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className="text-muted transition hover:text-ink">
              GitHub
            </a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer noopener" className="text-muted transition hover:text-ink">
              Docs
            </a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer noopener" className="text-muted transition hover:text-ink">
              Issues
            </a>
            <span className="text-faint">MIT licensed · no SaaS, no hosting, no paywall</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
