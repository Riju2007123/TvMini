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
  pickFiles,
  pickSaveFile,
  removeRecent,
  saveFile,
  writeSaveFile,
} from "./storage.js";
import { clipExportScale, createClipBuffer } from "./clip-write.js";
import {
  clipToProject,
  readClipDocumentFromBytes,
  readClipLayersFromBytes,
  readClipPreviewFromBytes,
} from "./clip.js";
import { createTvppBuffer, importTvppBytes } from "./tvpp.js";
import { parseFla } from "./fla-parser.js";
import { normalizeProject } from "./model.js";
import { renderPng } from "./png.js";
import { buildExport, EXPORT_KINDS } from "./export-kinds.js";
import { importPictures } from "./exporters.js";
import { writeSutBrush } from "./sut-write.js";

/* ------------------------------------------------------------ server backend */

/** Write a line down on the server, so the steps of the program can be seen. */
function reportToServer(message) {
  try {
    fetch("api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: String(message) }),
    }).catch(() => {});
  } catch {
    // Reporting is a convenience; a failure to report is not an error.
  }
}

/**
 * Ask the server about a path before it is written to.
 *
 * The answer is a convenience: it tells the program whether the file is
 * already there, so it can ask whether to replace it. A browser may block
 * the question, and that must not stop the export, so a question that fails
 * is answered with "nothing is known" and the export goes on.
 */
async function askAboutPath(path) {
  const url = `/api/stat?path=${encodeURIComponent(path)}`;
  try {
    return await serverRequest("GET", url);
  } catch (error) {
    reportToServer(`the question about the path failed: ${error.message}`);
    return { exists: false, dir: false, size: 0, path };
  }
}

async function serverRequest(method, endpoint, body) {
  let response;
  // A connection that was closed while it was idle makes the next request
  // fail, even though the program is there: the file dialog can be open for
  // a while, and the server closes the connection after five seconds. The
  // request is therefore tried once more, on a fresh connection. A file that
  // is written twice is the same file, so every kind of request may be
  // tried again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(endpoint, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
      break;
    } catch (error) {
      if (attempt > 0) {
        // The program on the server is not answering. It may have been
        // restarted while the work was going on, and the work is still there.
        reportToServer(`the request ${method} ${endpoint} failed: ${error.message}`);
        throw new Error(
          "the program on the server did not answer. It may have been restarted - " +
            "try again, and your work is not lost.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

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

    async open(path) {
      // The recent list of a server holds real paths, so a project is opened
      // by the path it was saved under.
      const data = await serverRequest("POST", "/api/open", { path });
      return { name: data.path, project: data.project, recent: data.recent };
    },

    async chooseAndOpen() {
      const path = await hooks.pickPath({ mode: "open", title: "Open project" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/open", { path });
      return { name: data.path, project: data.project, recent: data.recent };
    },

    async chooseAndImportClip() {
      const path = await hooks.pickPath({ mode: "open", title: "Import .clip" });
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

    /**
     * Choose and import a Flash `.fla` or `.xfl` file.
     *
     * The server reads the file and parses it, so the path comes back
     * as the file's own and the project is normalized the same way the
     * browser backend does with picked bytes.
     */
    async chooseAndImportFLA() {
      const path = await hooks.pickPath({ mode: "open", title: "Import .fla / .xfl (Flash)" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/import-fla", { path });
      return { name: data.name, path: data.path, project: data.project, warnings: data.warnings };
    },

    async importFl(path) {
      const data = await serverRequest("POST", "/api/import-fla", { path });
      return { name: data.name, path: data.path, project: data.project, warnings: data.warnings };
    },

    async chooseAndImportAudio() {
      const path = await hooks.pickPath({ mode: "open", title: "Import a sound" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/import-audio", { path });
      return { name: data.name, path: data.path, data: data.data };
    },

    async importTvpp(path) {
      const data = await serverRequest("POST", "/api/import-tvpp", { path });
      return { name: data.name, path: data.path, project: data.project, warnings: data.warnings };
    },

    /**
     * A file dropped on the window has no path the page could know, so it is
     * staged in a folder of the server's own and imported from there - the
     * very same importers a picked path goes through. The bytes travel as
     * base64, so a file of roughly 24 MB or more is too much for one request.
     */
    async stageDrop(session, name, bytes) {
      const data = await serverRequest("POST", "/api/drop-file", {
        session,
        name,
        data: bytesToBase64(bytes),
      });
      return data.path;
    },

    async importClipDropped(session, name, bytes) {
      return this.importClip(await this.stageDrop(session, name, bytes));
    },

    async importTvppDropped(session, name, bytes) {
      return this.importTvpp(await this.stageDrop(session, name, bytes));
    },

    async importFlaDropped(session, name, bytes) {
      return this.importFl(await this.stageDrop(session, name, bytes));
    },

    async importPicturesPaths(paths) {
      const data = await serverRequest("POST", "/api/import-pictures", { paths });
      return { name: data.name, path: data.path, project: data.project };
    },

    async importPicturesDropped(session, files) {
      const paths = [];
      for (const file of files) {
        paths.push(await this.stageDrop(session, file.name, file.bytes));
      }
      return this.importPicturesPaths(paths);
    },

    /**
     * A project opened from a drop has no path of its own until it is saved,
     * so it does not join a recent list that is made of paths. (The browser
     * backend keeps the file's content instead.)
     */
    async rememberProject() {
      return null;
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
        const info = await askAboutPath(clean);
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

    /**
     * Save bytes the page has already made - the time sheet image is drawn on
     * a canvas, not by the server - through the file dialog of the machine.
     */
    async saveBytes(bytes, name, title = "Save image") {
      const target = await hooks.pickPath({ mode: "save", title, name });
      if (!target) return null;
      const clean = /\.[^\\/]*$/.test(target.trim()) ? target.trim() : `${target.trim()}.png`;
      const info = await askAboutPath(clean);
      if (info.dir) throw new Error("that path is a folder, not a file");
      if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;
      const data = await serverRequest("POST", "/api/save-file", {
        path: clean,
        data: bytesToBase64(bytes),
      });
      return { path: data.path, bytes: data.bytes };
    },

    async exportClip(project, stem, sourcePath, onPath = null, picker = {}) {
      const target = await hooks.pickPath({
        mode: "save",
        title: "Export layered Clip Studio .clip",
        name: picker.name ?? `${stem}.clip`,
        start: picker.start ?? null,
      });
      if (!target) return null;
      reportToServer(`the export has the path ${target}`);

      const clean = withClipExtension(target);
      if (sourcePath && String(sourcePath).toLowerCase() === clean.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .clip file");
      }

      const info = await askAboutPath(clean);
      if (info.dir) throw new Error("that path is a folder, not a file");
      if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;

      // The file is built from here on, which takes a while for a document
      // with many layers, so the program is told that it is working.
      onPath?.(clean);

      return serverRequest("POST", "/api/export-clip", {
        path: clean,
        project,
        sourcePath: sourcePath ?? null,
      });
    },

    async exportFile(kind, project, stem, options) {
      const ext = EXPORT_KINDS[kind].ext;
      const target = await hooks.pickPath({
        mode: "save",
        title: `Export ${EXPORT_KINDS[kind].label}`,
        name: `${stem}.${ext}`,
      });
      if (!target) return null;
      const clean = /\.[^\\/]*$/.test(target.trim()) ? target.trim() : `${target.trim()}.${ext}`;
      reportToServer(`the export has the path ${clean}`);
      const statUrl = `/api/stat?path=${encodeURIComponent(clean)}`;
      reportToServer(`the export asks ${statUrl}`);
      const info = await askAboutPath(clean);
      reportToServer(`the server says the file ${info.exists ? "is there" : "is not there"}`);
      if (info.dir) throw new Error("that path is a folder, not a file");
      if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;
      return serverRequest("POST", "/api/export-file", { path: clean, project, kind, options });
    },

    /**
     * Write a brush as a Clip Studio Paint brush.
     *
     * The server makes the file, because it has the SQLite library that a
     * `.sut` file is built with.
     */
    async exportBrush(brush, name) {
      const target = await hooks.pickPath({
        mode: "save",
        title: "Export the brush as a Clip Studio Paint brush",
        name: `${name}.sut`,
      });
      if (!target) return null;
      const clean = /\.[^\\/]*$/.test(target.trim()) ? target.trim() : `${target.trim()}.sut`;
      reportToServer(`the brush export has the path ${clean}`);
      const info = await askAboutPath(clean);
      if (info.dir) throw new Error("that path is a folder, not a file");
      if (info.exists && !confirm(`Replace existing file?\n\n${clean}`)) return null;
      return serverRequest("POST", "/api/export-brush", { path: clean, brush });
    },

    async chooseAndImportPictures() {
      const path = await hooks.pickPath({ mode: "open", title: "Import picture (PNG, GIF, BMP, TGA)" });
      if (!path) return null;
      const data = await serverRequest("POST", "/api/import-pictures", { paths: [path] });
      return { name: data.name, path: data.path, project: data.project };
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

      const info = await askAboutPath(clean);
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
 * Build a `.clip` inside a Web Worker.
 *
 * A module worker is started for the one call and dropped afterwards. When
 * the machinery of the worker cannot be had at all (no `Worker`, or the file
 * would not start), the caller builds the file on the page instead; the
 * failure of the export itself is reported the same way as the page's own
 * failure would be, so that the caller's attempts with another skeleton go
 * on as before.
 */
function buildClipBuffer(project, { name, animation = null, scale }) {
  return new Promise((resolve, reject) => {
    let worker = null;
    try {
      worker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
    } catch (error) {
      reject(new Error(`the export worker could not be started: ${error?.message ?? error}`));
      return;
    }
    const finish = (settle) => {
      worker.terminate();
      settle();
    };
    worker.addEventListener("message", ({ data }) => {
      finish(() => {
        if (data.ok) resolve(data);
        else reject(new Error(data.message ?? "the .clip export failed in the worker"));
      });
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      finish(() => reject(new Error(event.message ?? "the .clip export worker failed")));
    });
    worker.postMessage({ project, name, animation: animation ?? null, scale });
  });
}

/** Build through the worker when it can, or on the page when it cannot. */
async function buildClipBufferAnywhere(project, options) {
  if (typeof Worker === "function") {
    try {
      return await buildClipBuffer(project, options);
    } catch (error) {
      // Only the machinery's failure falls back; the failure of the export
      // itself has to reach the caller.
      if (/worker/i.test(error.message ?? "")) return createClipBuffer(project, options);
      throw error;
    }
  }
  return createClipBuffer(project, options);
}

/**
 * @param {{pickPath: (options: {mode: string, title: string, name?: string}) => Promise<string|null>}} hooks
 */
function createBrowserBackend(hooks) {
  // The bytes of the .clip that was imported. A browser cannot re-read a
  // file by path, so they are kept: the writer needs them to copy the tracks
  // of that file into the one it writes, and the timeline with them.
  let clipSourceBytes = null;

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
      // The whole file comes in: the folders, the animation folders and the
      // layers inside them, each carrying its own picture.
      const [document, layers] = await Promise.all([
        readClipDocumentFromBytes(picked.bytes),
        readClipLayersFromBytes(picked.bytes, { includePaper: true }),
      ]);
      const project = clipToProject(document, layers);
      clipSourceBytes = picked.bytes;
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

    async chooseAndImportAudio() {
      const picked = await pickFile("audio/*");
      if (!picked) return null;
      return { name: picked.name, path: picked.name, data: bytesToBase64(picked.bytes) };
    },

    /**
     * A file dropped on the window is imported from the bytes it already
     * carries - no dialog, no staging. The session argument is ignored: it
     * only matters to the server backend.
     */
    async importClipDropped(_session, name, bytes) {
      const [document, layers] = await Promise.all([
        readClipDocumentFromBytes(bytes),
        readClipLayersFromBytes(bytes, { includePaper: true }),
      ]);
      const project = clipToProject(document, layers);
      clipSourceBytes = bytes;
      return { name, path: name, project };
    },

    async importTvppDropped(_session, name, bytes) {
      const imported = importTvppBytes(bytes);
      return { name, path: name, project: imported.project, warnings: imported.warnings };
    },

    async importFlaDropped(_session, name, bytes) {
      const parsed = parseFla(name || "untitled.fla", bytes);
      return {
        name,
        path: name,
        project: normalizeProject(parsed),
        warnings: parsed.warnings ?? [],
      };
    },

    async importPicturesDropped(_session, files) {
      const project = importPictures(files);
      return { name: files[0].name, path: files[0].name, project };
    },

    /**
     * A project opened from a drop keeps its content in the recent list, the
     * way a project opened from the picker does - a browser cannot re-read a
     * file by path, so the content is what makes the entry useful.
     */
    async rememberProject(name, text) {
      return addRecent(name, text);
    },

    async saveProject(project, currentName) {
      const text = `${JSON.stringify(project, null, 2)}\n`;
      const bytes = new TextEncoder().encode(text);
      const name = withTvminiExtension(currentName || "untitled");
      const saved = await saveFile(name, bytes, "project");
      if (!saved) return null;
      return { name: saved.name, bytes: bytes.length, recent: addRecent(saved.name, text) };
    },

    async exportPng(project, stem) {
      const name = `${stem}.png`;
      const { buffer, width, height } = renderPng(project);
      const saved = await saveFile(name, new Uint8Array(buffer), "png");
      if (!saved) return null;
      return { path: saved.name, bytes: buffer.length, width, height };
    },

    async saveBytes(bytes, name) {
      const saved = await saveFile(name, bytes, "png");
      if (!saved) return null;
      return { path: saved.name, bytes: bytes.length };
    },

    async exportClip(project, stem, sourceName, onPath = null, picker = {}) {
      const name = picker.name ?? `${stem}.clip`;
      if (sourceName && sourceName.toLowerCase() === name.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .clip file");
      }
      // The destination is asked for first, while the click is still fresh:
      // browsers only open the dialog at that moment, and the build below
      // holds the page for a while. The bytes are handed to the chosen place
      // after the file is built.
      const picked = await pickSaveFile(name, "clip");
      if (!picked) return null;
      // The animation is written when there is one to write. The file the
      // project was imported from is the skeleton of its tracks, and the
      // bundled document with a real animation in it is the skeleton of
      // everything else. A file that cannot be used as a skeleton is
      // exported without the timeline.
      const skeletons = [];
      if (clipSourceBytes) skeletons.push(clipSourceBytes);
      skeletons.push(true);
      // The layers of a `.clip` are pictures, and Clip Studio Paint fits a
      // small canvas to its window, so they are painted larger than the stage.
      // A document that came from a .clip is measured on its own canvas: it
      // is written back at the resolution it was made in.
      const scale = clipExportScale(project.width, project.height, {
        pasteboard: project.pasteboard !== false,
      });
      // When the browser would not show the dialog, the file goes the way of
      // the download instead; the status bar is told why at the same point
      // it is normally told that the building has begun.
      onPath?.(picked.name, picked.reason ?? null);
      let result = null;
      for (const skeleton of skeletons) {
        try {
          result = await buildClipBufferAnywhere(project, {
            name: picked.name.replace(/\.clip$/i, ""),
            animation: skeleton,
            scale,
          });
          break;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      if (!result) {
        result = await buildClipBufferAnywhere(project, {
          name: picked.name.replace(/\.clip$/i, ""),
          scale,
        });
      }
      const saved = await writeSaveFile(picked, new Uint8Array(result.buffer));
      if (!saved) return null;
      return {
        path: saved.name,
        bytes: result.buffer.length,
        width: result.width,
        height: result.height,
        stageWidth: result.stageWidth,
        stageHeight: result.stageHeight,
        scale: result.scale,
        layers: result.layers,
        animation: result.tracks ?? 0,
      };
    },

    async exportFile(kind, project, stem, options) {
      const built = buildExport(kind, project, stem, options);
      const saved = await saveFile(`${stem}.${built.ext}`, new Uint8Array(built.bytes));
      if (!saved) return null;
      for (const file of built.extra) await saveFile(`${stem}.${file.ext}`, new Uint8Array(file.bytes));
      return { path: saved.name, bytes: built.bytes.length, summary: built.summary, extra: built.extra.map((f) => `${stem}.${f.ext}`) };
    },

    /**
     * Write a brush as a Clip Studio Paint brush.
     *
     * Without a server the file is made in the page, with the SQLite build
     * that runs in the browser.
     */
    async exportBrush(brush, name) {
      const bytes = await writeSutBrush(brush);
      const saved = await saveFile(name.endsWith(".sut") ? name : `${name}.sut`, new Uint8Array(bytes), "sut");
      if (!saved) return null;
      return { path: saved.name, bytes: bytes.length };
    },

    async chooseAndImportPictures() {
      const picked = await pickFiles(".png,.gif,.bmp,.tga,image/png,image/gif,image/bmp");
      if (!picked) return null;
      const project = importPictures(picked);
      return { name: picked[0].name, path: picked[0].name, project };
    },

    /**
     * Choose and import a Flash `.fla` or `.xfl` file.
     *
     * A browser cannot hand a path to a parser process, so the whole
     * file is picked into memory and parsed here: the XFL package or
     * the binary compound file, whichever `fla-parser.js` detects.
     */
    async chooseAndImportFLA() {
      const picked = await pickFiles(".fla,.xfl");
      if (!picked) return null;
      const file = picked[0];
      if (!file) return null;
      const parsed = parseFla(file.name || "untitled.fla", file.bytes);
      // Same pipeline the server applies to `.clip` / `.tvpp` imports.
      return {
        name: file.name,
        path: file.name,
        project: normalizeProject(parsed),
        warnings: parsed.warnings ?? [],
      };
    },

    async exportTvpp(project, stem, sourceName) {
      const name = `${stem}.tvpp`;
      if (sourceName && sourceName.toLowerCase() === name.toLowerCase()) {
        throw new Error("refusing to overwrite the imported .tvpp file");
      }
      const buffer = createTvppBuffer(project);
      const saved = await saveFile(name, new Uint8Array(buffer), "tvpp");
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

export function bytesToBase64(bytes) {
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
