// A static file server, for the two things the tour needs to show in a browser:
// the deliverables Reel renders (demo/out), and Aangan's own production web
// build (its `dist/`).
//
//   node demo/serve.mjs <root> <port> [--spa]
//
// `--spa` serves index.html for any path that isn't a file on disk, which is
// what a client-routed export needs. Aangan's dev server would do this too, but
// its dev build carries an invisible error overlay that swallows clicks — so
// the tour films the production build, which is what a visitor sees anyway.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4599);
const spa = process.argv.includes("--spa");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};

const isFile = async (p) => {
  const s = await stat(p).catch(() => null);
  return Boolean(s && s.isFile());
};

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
  // Everything resolves under `root`; a path that climbs out of it is refused
  // rather than read, because this serves rendered media and a web build and
  // has no business reading anything else on the disk.
  let file = join(root, normalize(path).replace(/^[\\/]+/, ""));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!(await isFile(file))) {
    const asRoute = `${file.replace(/[\\/]+$/, "")}.html`;
    if (await isFile(asRoute)) file = asRoute;
    else if (spa) file = join(root, "index.html");
    else file = join(file, "index.html");
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // The demo is filmed twice and diffed; a cached response between runs
      // would make the second render disagree with the first for no reason.
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://localhost:${port}${spa ? " (spa)" : ""}`));
