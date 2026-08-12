// Zero-dependency static server for the TaskFlow example.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4321);
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

createServer(async (req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(dir, url));
    res.writeHead(200, { "content-type": types[extname(url)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`TaskFlow on http://localhost:${port}`));
