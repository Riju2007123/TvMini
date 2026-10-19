import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeProject, projectPath, ValidationError } from "./model.js";
import { createClipBuffer } from "./clip-write.js";
import { renderPng } from "./png.js";

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
 * Export the current frame as a layered Clip Studio Paint document.
 *
 * The writer uses a blank CSP document as a structural template, then rebuilds
 * the canvas, layer rows, offscreen block tables, and external image chunks.
 * TVMini timelines are not encoded as CSP animation tracks; each TVMini layer
 * becomes one raster layer containing its current-frame drawing.
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
  const name = path.basename(target, path.extname(target));
  const { buffer, width, height, layers } = await createClipBuffer(clean, { name });
  await writeAtomic(target, buffer);
  return { path: target, bytes: buffer.length, width, height, layers };
}
