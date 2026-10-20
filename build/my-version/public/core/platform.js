/**
 * One interface for TVMini's file operations, with two backends.
 *
 * When the Node server is running, the app talks to it over HTTP and gets
 * real filesystem paths, atomic writes and a directory browser. On a static
 * host such as GitHub Pages there is no server, so the browser backend does
 * the same work locally with the File System Access API, download links and
 * `localStorage`.
 *
 * The UI in `app.js` only uses this module, so it behaves the same in both
 * places.
 */
import {
  addRecent,
  listRecent,
  openRecent,
  pickFile,
  removeRecent,
  saveFile,
} from "./storage.js";
import { createClipBuffer } from "./clip-write.js";
import { readClipPreviewFromBytes } from "./clip.js";
import { createTvppBuffer, importTvppBytes } from "./tvpp.js";
import { normalizeProject } from "./model.js";
import { renderPng } from "./png.js";

/* ------------------------------------------------------------ server backend */

async function serverRequest(method, endpoint, body) {
  const response = await fetch(endpoint, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

/**
 * @param {{pickPath: (options: {mode: string, title: string, name?: string}) => Promise<string|null>}} hooks
 */
function createServerBackend(hooks) {
  return {
    mode: "server",

    async listRecent() {
      return (await serverRequest("GET", "/api/recent")).entries;
    },

    async listDirectory(dir) {
      return serverRequest("GET", `/api/list?dir=${encodeURIComponent(dir)}`);
    },

    async removeRecent(name) {
      return (await serverRequest("POST", "/api/recent/remove", { path: name })).entries;
    },

    async chooseAndOpen() {
      const path = await hooks.pickPath({ mode: "open", title: "Open project" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/open", { path });
      return { name: data.path, project: data.project, recent: data.recent };
    },

    async chooseAndImportClip() {
      const path = await hooks.pickPath({ mode: "open", title: "Import .clip preview" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/import-clip", { path });
      return { name: data.name, path: data.path, project: data.project };
    },

    async importClip(path) {
      const data = await serverRequest("POST", "/api/import-clip", { path });
      return { name: data.name, path: data.path, project: data.project };
    },

    async chooseAndImportTvpp() {
      const path = await hooks.pickPath({ mode: "open", title: "Import .tvpp (TVPaint)" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/import-tvpp", { path });
      return { name: data.name, path: data.path, project: data.project, warnings: data.warnings };
    },

    async importTvpp(path) {
      const data = await serverRequest("POST", "/api/import-tvpp", { path });
      return { name: data.name, path: data.path, project: data.project, warnings: data.warnings };
    },

    async saveProject(project, currentName, options = {}) {
      const target = currentName || (await hooks.pickPath({
        mode: "save",
        title: "Save project as",
        name: "untitled.tvmini",
      }));
      if (!target) return null;

      const clean = withTvminiExtension(target);
      if (options.saveAs) {
        const info = await serverRequest("GET", `/api/stat?path=${encodeURIComponent(clean)}`);
        if (info.dir) throw new Error("that path is a folder, not a file");
        if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;
      }

      const data = await serverRequest("POST", "/api/save", { path: clean, project });
      return { name: data.path, bytes: data.bytes, recent: data.recent };
    },

    async exportPng(project, stem) {
      const target = await hooks.pickPath({
        mode: "save",
        title: "Export current frame PNG",
        name: `${stem}.png`,
      });
      if (!target) return null;
      return serverRequest("POST", "/api/export", { path: target, project });
    },

    async exportClip(project, stem, sourcePath) {
      const target = await hooks.pickPath({
        mode: "save",
        title: "Export layered Clip Studio .clip",
        name: `${stem}.clip`,
      });
      if (!target) return null;

      const clean = withClipExtension(target);
      if (sourcePath && sourcePath.toLowerCase() === clean.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .clip file");
      }

      const info = await serverRequest("GET", `/api/stat?path=${encodeURIComponent(clean)}`);
      if (info.dir) throw new Error("that path is a folder, not a file");
      if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;

      return serverRequest("POST", "/api/export-clip", {
        path: clean,
        project,
        sourcePath: sourcePath ?? null,
      });
    },

    async exportTvpp(project, stem, sourcePath) {
      const target = await hooks.pickPath({
        mode: "save",
        title: "Export .tvpp (TVPaint)",
        name: `${stem}.tvpp`,
      });
      if (!target) return null;

      const clean = withTvppExtension(target);
      if (sourcePath && sourcePath.toLowerCase() === clean.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .tvpp file");
      }

      const info = await serverRequest("GET", `/api/stat?path=${encodeURIComponent(clean)}`);
      if (info.dir) throw new Error("that path is a folder, not a file");
      if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;

      return serverRequest("POST", "/api/export-tvpp", {
        path: clean,
        project,
        sourcePath: sourcePath ?? null,
      });
    },
  };
}

/* ----------------------------------------------------------- browser backend */

/**
 * @param {{pickPath: (options: {mode: string, title: string, name?: string}) => Promise<string|null>}} hooks
 */
function createBrowserBackend(hooks) {
  return {
    mode: "browser",

    async listRecent() {
      return listRecent();
    },

    async listDirectory() {
      // A browser cannot list a folder; the native file picker is used
      // instead, so the directory browser is never shown.
      throw new Error("browsers cannot list folders");
    },

    async removeRecent(name) {
      return removeRecent(name);
    },

    async open(name) {
      // A browser cannot re-open a file by path, so the recent list keeps
      // the project text and it is read back from there.
      const entry = listRecent().find((item) => item.name === name);
      if (!entry?.data) {
        throw new Error("that project is no longer available in this browser");
      }
      const project = normalizeProject(parseJson(entry.data));
      return { name: entry.name, project, recent: listRecent() };
    },

    async chooseAndOpen() {
      const picked = await pickFile(".tvmini,application/json");
      if (!picked) return null;
      const text = new TextDecoder().decode(picked.bytes);
      const project = normalizeProject(parseJson(text));
      return { name: picked.name, project, recent: addRecent(picked.name, text) };
    },

    async chooseAndImportClip() {
      const picked = await pickFile(".clip");
      if (!picked) return null;
      const preview = await readClipPreviewFromBytes(picked.bytes);
      const project = normalizeProject({
        format: "tvmini",
        version: 2,
        width: preview.width,
        height: preview.height,
        background: "#ffffff",
        image: {
          data: bytesToBase64(preview.png),
          width: preview.width,
          height: preview.height,
        },
        fps: 12,
        startFrame: 1,
        currentLayer: 0,
        currentFrame: 1,
        loop: true,
        layers: [
          {
            name: "Layer 1",
            type: "anim",
            visible: true,
            locked: false,
            opacity: 1,
            blend: "normal",
            preBehavior: "none",
            postBehavior: "hold",
            drawings: [],
          },
        ],
      });
      return { name: picked.name, path: picked.name, project };
    },

    async importClip(name) {
      // A browser cannot re-read a .clip by path, so a recent .clip entry is
      // opened from the stored copy instead.
      return this.open(name);
    },

    async chooseAndImportTvpp() {
      const picked = await pickFile(".tvpp");
      if (!picked) return null;
      const imported = importTvppBytes(picked.bytes);
      return { name: picked.name, path: picked.name, project: imported.project, warnings: imported.warnings };
    },

    async importTvpp(name) {
      // Same rule as .clip: a browser re-opens recent entries from storage.
      return this.open(name);
    },

    async saveProject(project, currentName) {
      const text = `${JSON.stringify(project, null, 2)}\n`;
      const bytes = new TextEncoder().encode(text);
      const name = withTvminiExtension(currentName || "untitled");
      const saved = await saveFile(name, bytes);
      if (!saved) return null;
      return { name: saved.name, bytes: bytes.length, recent: addRecent(saved.name, text) };
    },

    async exportPng(project, stem) {
      const name = `${stem}.png`;
      const { buffer, width, height } = renderPng(project);
      const saved = await saveFile(name, new Uint8Array(buffer));
      if (!saved) return null;
      return { path: saved.name, bytes: buffer.length, width, height };
    },

    async exportClip(project, stem, sourceName) {
      const name = `${stem}.clip`;
      if (sourceName && sourceName.toLowerCase() === name.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .clip file");
      }
      const result = await createClipBuffer(project, { name: name.replace(/\.clip$/i, "") });
      const saved = await saveFile(name, new Uint8Array(result.buffer));
      if (!saved) return null;
      return {
        path: saved.name,
        bytes: result.buffer.length,
        width: result.width,
        height: result.height,
        layers: result.layers,
      };
    },

    async exportTvpp(project, stem, sourceName) {
      const name = `${stem}.tvpp`;
      if (sourceName && sourceName.toLowerCase() === name.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .tvpp file");
      }
      const buffer = createTvppBuffer(project);
      const saved = await saveFile(name, new Uint8Array(buffer));
      if (!saved) return null;
      return { path: saved.name, bytes: buffer.length, width: project.width, height: project.height };
    },
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("not a valid TVMini project: the file is not JSON");
  }
}

/** Append `.tvmini` when the name has no extension. */
function withTvminiExtension(name) {
  const clean = name.trim();
  return /\.[^\\/]*$/.test(clean) ? clean : `${clean}.tvmini`;
}

/** Append `.clip` when the name has no extension. */
function withClipExtension(name) {
  const clean = name.trim();
  return /\.[^\\/]*$/.test(clean) ? clean : `${clean}.clip`;
}

/** Append `.tvpp` when the name has no extension. */
function withTvppExtension(name) {
  const clean = name.trim();
  return /\.[^\\/]*$/.test(clean) ? clean : `${clean}.tvpp`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * Detect which backend to use.
 *
 * The server is used when `/api/state` answers; otherwise the app runs as a
 * static site. The check runs once, at start-up.
 *
 * `hooks.pickPath` is supplied by the UI and opens the directory browser in
 * server mode.
 */
export async function detectBackend(hooks) {
  try {
    // The path is relative so the app works both at the root of a local
    // server and under a sub-path such as /repo-name/ on GitHub Pages.
    const response = await fetch("api/state", { cache: "no-store" });
    if (response.ok) {
      const body = await response.json();
      if (body && Array.isArray(body.recent)) return createServerBackend(hooks);
    }
  } catch {
    // No server: fall through to the browser backend.
  }
  return createBrowserBackend(hooks);
}
