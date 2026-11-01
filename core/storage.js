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
    // Keep the input in the layout (off-screen) instead of display:none:
    // some browsers refuse to open a chooser for a display:none input.
    input.style.position = "fixed";
    input.style.top = "-1000px";
    input.style.left = "-1000px";
    input.style.opacity = "0";
    if (accept) input.accept = accept;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(value);
    };

    // A cancelled picker fires no "change" event, so the window regaining
    // focus is used to settle the promise. Wait long enough (1 s) that a
    // "change" that is still in flight can win the race.
    const onFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish(null);
      }, 1000);
    };

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      finish({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    });

    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
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
  sut: {
    description: "Clip Studio Paint brush",
    mime: "application/octet-stream",
    extensions: [".sut"],
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
    let handle = null;
    let writable = null;
    try {
      handle = await window.showSaveFilePicker({
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
      writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      writable = null;

      // The picker can report success while the bytes never reach the disk
      // (Chromium writes to a swap file and only commits on close). Read the
      // file back to be sure it really holds what we wrote; otherwise fall
      // through to the download below instead of leaving a 0-byte file.
      let onDisk = null;
      try {
        const file = await handle.getFile();
        onDisk = file.size;
      } catch {
        onDisk = null;
      }
      if (onDisk !== null && onDisk !== bytes.length) {
        throw new Error(
          `the file on disk is ${onDisk} bytes but ${bytes.length} were written`,
        );
      }
      return { name: handle.name ?? name, method: "picker" };
    } catch (error) {
      // A cancelled picker is not an error worth reporting.
      if (error?.name === "AbortError") return null;
      // Make sure Chromium cleans up the swap file instead of leaving a
      // half-written target behind.
      if (writable) {
        try {
          await writable.abort();
        } catch {
          // abort is best-effort
        }
      }
      // Fall through to the download fallback below so the user still gets a
      // complete file (in their Downloads folder) instead of a 0-byte one.
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

/**
 * Show the save dialog on its own, while the click that opened it is still
 * fresh.
 *
 * Browsers only allow the dialog while the hand of the user is still on the
 * page, so a long build must not sit between the click and the dialog: ask
 * first, build second, and hand the bytes over with `writeSaveFile`.
 *
 * The answer is `{name, handle}` when the browser has the File System
 * Access API, `{name, download: true}` when it does not (the bytes are then
 * downloaded), and `null` when the dialog was cancelled.
 */
export async function pickSaveFile(name, kind = null) {
  const wanted = kind ? FILE_KINDS[kind] : null;
  if (typeof window.showSaveFilePicker !== "function") {
    return { name, download: true };
  }
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
    return { name: handle.name ?? name, handle };
  } catch (error) {
    // A cancelled dialog is not an error; a refused one falls back to the
    // way of the download, and why it happened comes along so that the
    // status bar can say it.
    if (error?.name === "AbortError") return null;
    return {
      name,
      download: true,
      reason: error?.message ? `the save dialog was refused: ${error.message}` : String(error),
    };
  }
}

/**
 * Write the bytes into the place `pickSaveFile` chose.
 *
 * The file is read back afterwards, because the picker can report success
 * while the bytes never reach the disk: Chromium writes into a swap file and
 * only commits on close.
 */
export async function writeSaveFile(picked, bytes) {
  if (picked.download || !picked.handle) {
    return saveFile(picked.name, bytes);
  }
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  let writable = null;
  try {
    writable = await picked.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    writable = null;
    let onDisk = null;
    try {
      onDisk = (await picked.handle.getFile()).size;
    } catch {
      onDisk = null;
    }
    if (onDisk !== null && onDisk !== bytes.length) {
      throw new Error(
        `the file on disk is ${onDisk} bytes but ${bytes.length} were written`,
      );
    }
    return { name: picked.name, method: "picker" };
  } catch (error) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // abort is best-effort
      }
    }
    if (error?.name === "AbortError") return null;
    return saveFile(picked.name, bytes);
  }
}

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
    input.style.position = "fixed";
    input.style.top = "-1000px";
    input.style.left = "-1000px";
    input.style.opacity = "0";
    if (accept) input.accept = accept;

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(value);
    };
    const onFocus = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish(null);
      }, 1000);
    };
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      if (files.length === 0) return finish(null);
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      finish(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    });
    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
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
