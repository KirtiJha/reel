import Link from "next/link";
import { Logo } from "./Logo";

/**
 * What the workspace routes render on the public site.
 *
 * Author, Studio and Gallery drive a real browser, run ffmpeg, execute the
 * spec's shell commands and read the workspace off disk — none of which a
 * hosted page can do, and the app it records is on the visitor's own machine
 * anyway. Rather than deploy those routes as a shell that fails on its first
 * fetch, the public build answers with the install command.
 */
export function LocalOnly() {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="page max-w-[52rem] text-center">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <Logo size={30} />
          <span className="text-[17px] font-bold tracking-tight">Reel</span>
        </div>

        <h1 className="text-[38px] font-bold leading-tight tracking-[-0.02em] max-[720px]:text-[28px]">
          Studio runs on your machine
        </h1>
        <p className="prose-muted mx-auto mt-4 max-w-[56ch]">
          Reel drives your real app in a real browser and renders the video locally, so the
          workspace can&apos;t live on a website — the app it records is on your machine, not this
          one. It&apos;s one command:
        </p>

        <div className="mx-auto mt-8 max-w-[34rem] overflow-hidden rounded-2xl border border-line bg-panel text-left shadow-panel">
          <div className="flex items-center gap-2 border-b border-line bg-bg2 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[1.9] text-muted">
            <span className="text-faint">$ </span>npx @kirti_jha/reel init{"\n"}
            <span className="text-faint">$ </span>npx @kirti_jha/reel ui
          </pre>
        </div>

        <p className="mt-6 text-[13.5px] text-faint">
          Nothing is uploaded, and your model keys stay in your own{" "}
          <span className="font-mono">.env</span>.
        </p>

        <Link href="/" className="btn btn-ghost mt-8">
          ← Back to the overview
        </Link>
      </div>
    </div>
  );
}
