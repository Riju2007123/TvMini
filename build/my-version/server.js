import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProject, normalizeProject, ValidationError } from "./src/model.js";
import { readClipPreview } from "./src/clip.js";
import { RecentStore, defaultRecentFile } from "./src/recent.js";
import { exportPng, openProject, saveProject } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const BODY_LIMIT = 32 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function statusFor(error) {
  if (error instanceof ValidationError) return 400;
  if (error?.code === "ENOENT") return 404;
  if (error?.code === "EACCES" || error?.code === "EPERM") return 403;
  if (error?.code === "ENOSPC") return 507;
  return 500;
}

function messageFor(error) {
  if (error instanceof ValidationError) return error.message;
  if (error?.code === "EACCES" || error?.code === "EPERM") return "permission denied";
  if (error?.code === "ENOSPC") return "the disk is full";
  return error?.message || "unexpected error";
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT) throw new ValidationError("request body is too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("request body is not valid JSON");
  }
}

async function statPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  if (rawPath.includes("\0")) throw new ValidationError("invalid path");

  const target = path.resolve(rawPath);
  try {
    const stat = await fsp.stat(target);
    return { exists: true, dir: stat.isDirectory(), size: stat.size, path: target };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, dir: false, size: 0, path: target };
    throw error;
  }
}

async function listDirectory(rawDir) {
  if (typeof rawDir !== "string" || rawDir.trim() === "") rawDir = process.cwd();
  if (rawDir.includes("\0")) throw new ValidationError("invalid directory");
  if (rawDir.split(/[\\/]+/).includes("..")) throw new ValidationError("invalid directory");

  const dir = path.resolve(rawDir);
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) throw new ValidationError(`not a directory: ${dir}`);

  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    if (dirent.name === "." || dirent.name === "..") continue;
    const full = path.join(dir, dirent.name);
    let size = 0;
    try {
      const info = await fsp.stat(full);
      size = info.size;
    } catch {
      continue;
    }
    entries.push({ name: dirent.name, path: full, dir: dirent.isDirectory(), size });
  }

  entries.sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
  const parent = path.dirname(dir);

  return { dir, parent: parent === dir ? null : parent, entries };
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC, relative);

  if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  let body;
  try {
    body = await fsp.readFile(target);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    throw error;
  }

  res.writeHead(200, {
    "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

export async function startServer({ port = 4123, recentFile = defaultRecentFile() } = {}) {
  const recent = new RecentStore(recentFile);
  await recent.load();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /api/state") {
        sendJson(res, 200, {
          recent: recent.list(),
          cwd: process.cwd(),
          home: os.homedir(),
          platform: process.platform,
        });
        return;
      }

      if (route === "GET /api/recent") {
        sendJson(res, 200, { entries: recent.list() });
        return;
      }

      if (route === "POST /api/recent/remove") {
        const body = await readJson(req);
        sendJson(res, 200, { entries: await recent.remove(body.path) });
        return;
      }

      if (route === "GET /api/list") {
        sendJson(res, 200, await listDirectory(url.searchParams.get("dir")));
        return;
      }

      if (route === "GET /api/stat") {
        sendJson(res, 200, await statPath(url.searchParams.get("path")));
        return;
      }

      if (route === "POST /api/open") {
        const body = await readJson(req);
        const result = await openProject(body.path);
        sendJson(res, 200, { ...result, recent: await recent.add(result.path) });
        return;
      }

      if (route === "POST /api/import-clip") {
        const body = await readJson(req);
        const preview = await readClipPreview(body.path);
        const project = normalizeProject({
          ...createProject(preview.width, preview.height),
          image: {
            data: preview.png.toString("base64"),
            width: preview.width,
            height: preview.height,
          },
        });
        sendJson(res, 200, { path: preview.path, name: preview.name, project });
        return;
      }

      if (route === "POST /api/save") {
        const body = await readJson(req);
        const result = await saveProject(body.path, body.project);
        sendJson(res, 200, { path: result.path, bytes: result.bytes, recent: await recent.add(result.path) });
        return;
      }

      if (route === "POST /api/export") {
        const body = await readJson(req);
        sendJson(res, 200, await exportPng(body.path, body.project));
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "unknown endpoint" });
        return;
      }

      if (req.method === "GET") {
        await serveStatic(req, res, url.pathname);
        return;
      }

      sendJson(res, 405, { error: "method not allowed" });
    } catch (error) {
      sendJson(res, statusFor(error), { error: messageFor(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    recent,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex === -1 ? 4123 : Number(process.argv[portIndex + 1]);
  const app = await startServer({ port });
  console.log(`TVMini running at ${app.url}`);
}
