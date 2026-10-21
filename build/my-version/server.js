import http from "node:http";
import fsp from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProject, normalizeProject, ValidationError } from "./src/model.js";
import { readClipDocument, readClipPreview, readClipProject } from "./src/clip.js";
import { createTvppBuffer, importTvppBytes } from "./src/tvpp.js";
import { RecentStore, defaultRecentFile } from "./src/recent.js";
import {
  exportClip,
  exportFile,
  exportPng,
  importPictureFiles,
  openProject,
  saveProject,
  exportTvpp,
} from "./src/store.js";

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

/** Where the calls of the server are written down. */
function requestLogFile() {
  return path.join(os.tmpdir(), "tvmini-server.log");
}

export async function startServer({ port = 4123, recentFile = defaultRecentFile() } = {}) {
  const recent = new RecentStore(recentFile);
  await recent.load();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    // Every call is written down with what it answered, so a request that did
    // not do what it should can be seen afterwards.
    const write = (line) => {
      console.log(line.trimEnd());
      try {
        appendFileSync(requestLogFile(), line);
      } catch (error) {
        console.error(`[tvmini] the request log could not be written: ${error.message}`);
      }
    };
    const noted = { done: false };
    const note = (status, detail = "") => {
      if (noted.done || !url.pathname.startsWith("/api/")) return;
      noted.done = true;
      write(`${new Date().toISOString()} ${route} -> ${status}${detail ? ` ${detail}` : ""}\n`);
    };
    res.on("finish", () => note(res.statusCode));

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
        // The whole file comes in: every raster layer of the document
        // becomes a layer of the project, carrying its own picture.
        const body = await readJson(req);
        const imported = await readClipProject(body.path);
        sendJson(res, 200, {
          path: imported.path,
          name: imported.name,
          project: imported.project,
          document: imported.document,
        });
        return;
      }

      if (route === "GET /api/inspect-clip") {
        // A read-only report of what is inside a .clip file. The file is
        // opened, never written.
        const document = await readClipDocument(url.searchParams.get("path"));
        sendJson(res, 200, {
          ...document,
          preview: {
            width: document.preview.width,
            height: document.preview.height,
            png: document.preview.png.toString("base64"),
          },
        });
        return;
      }

      if (route === "POST /api/import-tvpp") {
        const body = await readJson(req);
        const target = path.resolve(body.path);
        const bytes = await fsp.readFile(target);
        const imported = importTvppBytes(bytes);
        sendJson(res, 200, {
          path: target,
          name: path.basename(target),
          project: imported.project,
          warnings: imported.warnings,
        });
        return;
      }

      if (route === "POST /api/import-audio") {
        const body = await readJson(req);
        const target = path.resolve(body.path);
        const bytes = await fsp.readFile(target);
        // The browser decodes the sound, so the server only ships the bytes.
        if (bytes.length > 12_000_000) {
          sendJson(res, 400, { error: "that sound file is too large (max 12 MB)" });
          return;
        }
        sendJson(res, 200, {
          path: target,
          name: path.basename(target),
          data: bytes.toString("base64"),
        });
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

      if (route === "POST /api/client-log") {
      const body = await readJson(req);
      const line = `${new Date().toISOString()} client: ${body.message ?? ""}\n`;
      console.log(line.trimEnd());
      try {
        appendFileSync(requestLogFile(), line);
      } catch {
        // The log is a convenience; a failure to write it is not an error.
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (route === "POST /api/export-clip") {
        const body = await readJson(req);
        sendJson(res, 200, await exportClip(body.path, body.project, body.sourcePath));
        return;
      }

      if (route === "POST /api/export-file") {
        const body = await readJson(req);
        sendJson(res, 200, await exportFile(body.path, body.project, body.kind, body.options));
        return;
      }

      if (route === "POST /api/import-pictures") {
        const body = await readJson(req);
        const project = await importPictureFiles(body.paths);
        sendJson(res, 200, { project, name: path.basename(String(body.paths[0])), path: path.resolve(String(body.paths[0])) });
        return;
      }

      if (route === "POST /api/export-tvpp") {
        const body = await readJson(req);
        sendJson(res, 200, await exportTvpp(body.path, body.project, body.sourcePath));
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
      const status = statusFor(error);
      note(status, messageFor(error));
      sendJson(res, status, { error: messageFor(error) });
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
  console.log(`requests are written to ${requestLogFile()}`);
}
