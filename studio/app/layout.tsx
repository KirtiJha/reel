import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { REPO_URL, SITE_URL } from "@/lib/site";

const TITLE = "Reel — demos as code, for web apps and CLIs";
const DESCRIPTION =
  "Describe the demo or script it. Reel drives your real app, renders a polished GIF, video, storyboard or interactive walkthrough — then fails your build the moment the flow breaks. Open source, MIT, runs locally and in CI.";

/**
 * Metadata is load-bearing for this page in particular: it exists to be shared,
 * and a pasted link is judged on its card before anyone clicks. The title is
 * the product, not the app — "Reel Studio" named the local workspace and read
 * as the wrong thing in a feed.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Reel",
  keywords: [
    "demo automation",
    "screencast",
    "documentation",
    "playwright",
    "GIF",
    "README",
    "CI",
    "demos as code",
  ],
  openGraph: {
    type: "website",
    siteName: "Reel",
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  alternates: { canonical: SITE_URL },
  other: { "repository": REPO_URL },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
