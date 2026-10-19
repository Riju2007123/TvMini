/**
 * Serve `public/` as a plain static site, the way GitHub Pages does.
 *
 * This is used to check the browser build without a Node backend: there is
 * no `/api` endpoint, so the app must fall back to its browser storage.
 *
 *   node scripts/serve-static.mjs [port]
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "public");
const PORT = Number(process.argv[2] ?? 8123);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".clip": "application/octet-stream",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);

  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await fs.readFile(target);
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      // This server is only used while developing; never cache, so a
      // rebuilt file is picked up on reload.
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : 500).end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`static build at http://127.0.0.1:${PORT}`);
});
