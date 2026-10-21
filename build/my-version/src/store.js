import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeProject, projectPath, ValidationError } from "./model.js";
import { createClipBuffer } from "./clip-write.js";
import { createTvppBuffer } from "./tvpp.js";
import { renderPng } from "./png.js";
import { buildExport, EXPORT_KINDS } from "../public/core/export-kinds.js";
import { importPictures } from "../public/core/exporters.js";

function tempName(target) {
  return `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Write bytes atomically: temp file -> fsync -> rename (SPEC 3.1).
 * On any failure the temp file is removed and the target is untouched.
 */
export async function writeAtomic(target, bytes) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = tempName(target);
  let handle;

  try {
    handle = await fsp.open(temp, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function saveProject(filePath, project) {
  const clean = normalizeProject(project);
  const target = projectPath(filePath);
  const text = `${JSON.stringify(clean, null, 2)}\n`;
  await writeAtomic(target, text);
  return { path: target, bytes: Buffer.byteLength(text), project: clean };
}

export async function openProject(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const target = path.resolve(filePath.trim());

  let text;
  try {
    text = await fsp.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new ValidationError(`file not found: ${target}`);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError(`not valid JSON: ${target}`);
  }

  return { path: target, project: normalizeProject(parsed) };
}

export async function exportPng(filePath, project) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = normalizeProject(project);
  const target = path.resolve(path.extname(filePath) === "" ? `${filePath}.png` : filePath);
  const { buffer, width, height } = renderPng(clean);
  await writeAtomic(target, buffer);
  return { path: target, bytes: buffer.length, width, height };
}

/**
 * Export the project as a layered Clip Studio Paint document.
 *
 * The writer uses a blank CSP document as a structural template, then rebuilds
 * the canvas, layer rows, offscreen block tables, and external image chunks.
 *
 * The animation of the project is written as tracks of Clip Studio's own. The
 * skeleton of those tracks is the `.clip` the project was imported from when
 * there is one, and the small document with a real animation in it that ships
 * with the program otherwise. A skeleton that cannot be read is not a reason
 * to refuse the export: the file is written without a timeline then.
 */
export async function exportClip(filePath, project, sourcePath = null) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = normalizeProject(project);
  const target = path.resolve(path.extname(filePath) === "" ? `${filePath}.clip` : filePath);
  if (
    typeof sourcePath === "string" &&
    sourcePath.trim() !== "" &&
    path.resolve(sourcePath).toLowerCase() === target.toLowerCase()
  ) {
    throw new ValidationError("refusing to overwrite the imported .clip file");
  }
  let animation = true;
  if (typeof sourcePath === "string" && sourcePath.trim() !== "") {
    try {
      animation = await fsp.readFile(sourcePath);
    } catch {
      animation = true;
    }
  }
  const name = path.basename(target, path.extname(target));
  let written;
  try {
    written = await createClipBuffer(clean, { name, animation });
  } catch (error) {
    // The animation skeleton is a convenience: a `.clip` that cannot be read
    // back (or that holds no track) still exports, only without the timeline.
    if (!(error instanceof ValidationError)) throw error;
    written = await createClipBuffer(clean, { name });
  }
  const { buffer, width, height, layers, tracks } = written;
  await writeAtomic(target, buffer);
  return {
    path: target,
    bytes: buffer.length,
    width,
    height,
    layers,
    animation: tracks ?? 0,
  };
}

/**
 * Export the project as a TVPaint Animation `.tvpp` file (every drawing
 * becomes raster layer frames; timeline hold runs become repeated frames).
 *
 * INFERRED: the byte grammar came from reverse engineering and needs one
 * round trip through real TVPaint before we claim full fidelity there.
 * Like every writer here it refuses to overwrite the file the data came
 * from, and it always writes a fresh file.
 */
export async function exportTvpp(filePath, project, sourcePath = null) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = normalizeProject(project);
  const target = path.resolve(path.extname(filePath) === "" ? `${filePath}.tvpp` : filePath);
  if (
    typeof sourcePath === "string" &&
    sourcePath.trim() !== "" &&
    path.resolve(sourcePath).toLowerCase() === target.toLowerCase()
  ) {
    throw new ValidationError("refusing to overwrite the imported .tvpp file");
  }
  const buffer = createTvppBuffer(clean);
  await writeAtomic(target, buffer);
  return { path: target, bytes: buffer.length, width: clean.width, height: clean.height };
}

/**
 * Export a PSD, timesheet, GIF, sprite sheet or image sequence.
 * The sprite sheet also writes a `.json` description next to the picture.
 */
export async function exportFile(filePath, project, kind, options = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  if (!Object.hasOwn(EXPORT_KINDS, kind)) throw new ValidationError(`unknown export kind: ${kind}`);
  const clean = normalizeProject(project);
  const ext = EXPORT_KINDS[kind].ext;
  const target = path.resolve(path.extname(filePath) === "" ? `${filePath}.${ext}` : filePath);
  const stem = path.basename(target, path.extname(target));
  let built;
  try {
    built = buildExport(kind, clean, stem, options);
  } catch (error) {
    throw new ValidationError(error.message);
  }
  await writeAtomic(target, built.bytes);
  const extra = [];
  for (const file of built.extra) {
    const side = path.join(path.dirname(target), `${stem}.${file.ext}`);
    await writeAtomic(side, file.bytes);
    extra.push(side);
  }
  return { path: target, bytes: built.bytes.length, summary: built.summary, extra };
}

/** Read pictures (PNG, GIF, BMP, TGA) from disk into a new project. */
export async function importPictureFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 2000) {
    throw new ValidationError("one or more picture paths are required");
  }
  const files = [];
  for (const file of paths) {
    const target = path.resolve(String(file));
    let bytes;
    try {
      bytes = await fsp.readFile(target);
    } catch (error) {
      if (error.code === "ENOENT") throw new ValidationError(`file not found: ${target}`);
      throw error;
    }
    files.push({ name: path.basename(target), bytes });
  }
  try {
    return importPictures(files);
  } catch (error) {
    throw new ValidationError(error.message);
  }
}
