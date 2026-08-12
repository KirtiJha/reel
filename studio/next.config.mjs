// The Next.js UI proxies data/media calls to the in-process Reel API server
// (started by `reel ui`). Same-origin from the browser → no CORS.
const api = process.env.REEL_API_URL || "http://localhost:4499";

/** @type {import('next').NextConfig} */
const config = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/media", destination: `${api}/media` },
    ];
  },
};

export default config;
