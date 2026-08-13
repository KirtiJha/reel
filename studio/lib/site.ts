/**
 * Where the project lives.
 *
 * Kept in one place because these strings appear in metadata, the nav, the
 * footer and the quickstart — and a landing page with a stale or missing repo
 * link is worse than one with no link at all.
 */

export const REPO_URL = "https://github.com/KirtiJha/reel";
export const REPO_SLUG = "KirtiJha/reel";

/** Docs live in the repository until there's a docs site to point at. */
export const DOCS_URL = `${REPO_URL}#readme`;
export const SPEC_DOCS_URL = `${REPO_URL}/blob/main/examples/taskflow/demo.reel.yaml`;
export const ISSUES_URL = `${REPO_URL}/issues`;

/**
 * Canonical origin for metadata.
 *
 * Order matters. `VERCEL_URL` is the *per-deployment* hostname — it changes on
 * every push, so using it would point `og:url` and the canonical link at a
 * throwaway preview host. `VERCEL_PROJECT_PRODUCTION_URL` is the stable
 * production domain, which is what a shared link should resolve to. Set
 * `NEXT_PUBLIC_SITE_URL` explicitly once a custom domain is attached.
 */
const vercelHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;

/*
 * The last resort is localhost rather than a guessed domain: `SITE_URL` becomes
 * `metadataBase`, so a placeholder like "reel.dev" would resolve `og:image`
 * against a host we don't control and serve a dead card. Off a deployment,
 * metadata isn't read by anything anyway.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (vercelHost ? `https://${vercelHost}` : "http://localhost:3000");
