"use client";
import { useEffect, useState } from "react";
import { REPO_SLUG, REPO_URL } from "@/lib/site";

/**
 * Repository link, with the star count when it can be fetched.
 *
 * For an MIT project the repo is the real destination — someone who believes
 * the pitch wants to read the code, and the star count is the only credibility
 * signal a new project has. The count is fetched client-side and is strictly
 * decoration: GitHub rate-limits unauthenticated calls and a corporate network
 * may block the request entirely, so the link renders and works either way.
 */
export function GitHubLink({ compact = false }: { compact?: boolean }) {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`https://api.github.com/repos/${REPO_SLUG}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // A badge reading "0" advertises an empty metric and reads worse than
        // no badge at all, so the count only appears once there is one.
        if (typeof d?.stargazers_count === "number" && d.stargazers_count > 0) {
          setStars(d.stargazers_count);
        }
      })
      .catch(() => {
        /* rate-limited, offline or blocked — the link still works */
      });
    return () => ac.abort();
  }, []);

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer noopener"
      className={`btn btn-ghost ${compact ? "btn-sm" : ""} gap-2`}
      aria-label="View Reel on GitHub"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      GitHub
      {stars !== null && (
        <span className="border-l border-line2 pl-2 text-muted">
          {stars.toLocaleString()}
        </span>
      )}
    </a>
  );
}
