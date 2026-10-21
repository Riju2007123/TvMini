/**
 * Browser storage for TVMini.
 *
 * A static site has no server-side filesystem, so this module provides the
 * equivalents of the Node server's file operations:
 *
 *  - open / save a `.tvmini` project
 *  - export the current frame as a PNG
 *  - export the current frame as a layered `.clip`
 *  - import the preview from a `.clip`
 *  - keep a most-recently-used list
 *
 * Files are read with an `<input type="file">` element and written with a
 * download link, so the app works in any browser and needs no server.
 * The File System Access API is used when the browser supports it, because it
 * allows saving back to the same file without a download prompt.
 *
 * The recent list lives in `localStorage`. A browser cannot re-open a file it
 * did not keep a handle for, so the recent list stores the project content
 * alongside the name; that keeps "recent" useful without a filesystem.
 */

/** How many recent projects to remember. */
export const MAX_RECENT = 50;

const RECENT_KEY = "tvmini.recent.v1";

/* ------------------------------------------------------------------ storage */

function readRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt list must never stop the app from starting.
    return [];
  }
}

function writeRecent(entries) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be full or blocked; the app still works without a list.
  }
}

/** The most-recently-used list, newest first. */
export function listRecent() {
  return readRecent().map((entry) => ({
    path: entry.name,
    name: entry.name,
    exists: true,
    data: entry.data ?? null,
  }));
}

export function addRecent(name, data) {
  const entries = readRecent().filter((entry) => entry.name !== name);
  entries.unshift({ name, data: data ?? null });
  writeRecent(entries.slice(0, MAX_RECENT));
  return listRecent();
}

export function removeRecent(name) {
  writeRecent(readRecent().filter((entry) => entry.name !== name));
  return listRecent();
}

/* ------------------------------------------------------------------- files */

/** Ask the user for a file and return its name and bytes. */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(value);
    };

    // A cancelled picker fires no event, so the window regaining focus is
    // used to settle the promise.
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 400);
    };

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      finish({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    });

    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/**
 * The kinds of file the app writes.
 *
 * The dialog of the browser is told which kind is wanted, so it offers that
 * one kind instead of every file on the machine.
 */
export const FILE_KINDS = {
  project: {
    description: "TVMini project",
    mime: "application/json",
    extensions: [".tvmini"],
  },
  png: {
    description: "PNG image",
    mime: "image/png",
    extensions: [".png"],
  },
  clip: {
    description: "Clip Studio Paint document",
    mime: "application/octet-stream",
    extensions: [".clip"],
  },
  tvpp: {
    description: "TVPaint Animation document",
    mime: "application/octet-stream",
    extensions: [".tvpp"],
  },
};

/**
 * Save bytes to a file, using the File System Access API when available.
 *
 * `kind` is one of the keys of `FILE_KINDS`. The dialog of the browser then
 * only offers the kind of file that is wanted, and the name it suggests
 * already carries the right extension.
 */
export async function saveFile(name, bytes, kind = null) {
  const wanted = kind ? FILE_KINDS[kind] : null;
  const blob = new Blob([bytes], { type: wanted?.mime ?? "application/octet-stream" });

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        // Without this the dialog offers every file type there is.
        ...(wanted
          ? {
              types: [
                {
                  description: wanted.description,
                  accept: { [wanted.mime]: wanted.extensions },
                },
              ],
            }
          : {}),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { name: handle.name ?? name, method: "picker" };
    } catch (error) {
      // A cancelled picker is not an error worth reporting.
      if (error?.name === "AbortError") return null;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name, method: "download" };
}

/* ---------------------------------------------------------------- projects */

function decodeProject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not a valid TVMini project: the file is not JSON");
  }
  return parsed;
}

/** Ask the user for one or more files; resolves to `[{name, bytes}]` or null. */
export function pickFiles(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (accept) input.accept = accept;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(value);
    };
    const onFocus = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 400);
    };
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      if (files.length === 0) return finish(null);
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      finish(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    });
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/** Open a `.tvmini` project chosen by the user. */
export async function openProject() {
  const picked = await pickFile(".tvmini,application/json");
  if (!picked) return null;

  const text = new TextDecoder().decode(picked.bytes);
  const project = decodeProject(text);
  return { name: picked.name, project };
}

/** Save a project and remember it in the recent list. */
export async function saveProject(project, name) {
  const text = `${JSON.stringify(project, null, 2)}\n`;
  const bytes = new TextEncoder().encode(text);
  const saved = await saveFile(name, bytes);
  if (!saved) return null;
  return { name: saved.name, bytes: bytes.length };
}

/** Re-open a project from the recent list. */
export function openRecent(entry) {
  if (!entry?.data) return null;
  try {
    return { name: entry.name, project: decodeProject(entry.data) };
  } catch {
    return null;
  }
}
