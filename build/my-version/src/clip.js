import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import {
  readClipPreviewFromBytes,
  readClipDocumentFromBytes,
  readClipLayersFromBytes,
  clipToProject,
} from "../public/core/clip.js";
import { ValidationError } from "../public/core/model.js";

export {
  findClipDatabase,
  readClipPreviewFromBytes,
  readClipDocumentFromBytes,
  readClipLayersFromBytes,
} from "../public/core/clip.js";

/**
 * Read the canvas preview from a `.clip` file on disk.
 *
 * The parsing itself lives in `public/core/clip.js` so the browser build can
 * reuse it; this wrapper only adds the filesystem.
 */
export async function readClipPreview(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }

  const clean = path.normalize(filePath.trim());
  if (path.extname(clean).toLowerCase() !== ".clip") {
    throw new ValidationError("choose a .clip file");
  }

  const data = Buffer.from(await fs.readFile(clean));
  const preview = await readClipPreviewFromBytes(data);
  return { path: clean, name: path.basename(clean), ...preview };
}


/** Read the preview plus inspectable native .clip document metadata. */
export async function readClipDocument(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = path.normalize(filePath.trim());
  if (path.extname(clean).toLowerCase() !== ".clip") {
    throw new ValidationError("choose a .clip file");
  }
  const data = Buffer.from(await fs.readFile(clean));
  const [preview, document] = await Promise.all([
    readClipPreviewFromBytes(data),
    readClipDocumentFromBytes(data),
  ]);
  return { path: clean, name: path.basename(clean), ...document, preview };
}

/**
 * Read the pixels of every raster layer in a `.clip` file.
 *
 * The tiles are decoded into straight RGBA buffers, one per layer.
 */
export async function readClipLayers(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = path.normalize(filePath.trim());
  if (path.extname(clean).toLowerCase() !== ".clip") {
    throw new ValidationError("choose a .clip file");
  }
  const data = Buffer.from(await fs.readFile(clean));
  const layers = await readClipLayersFromBytes(data);
  return { path: clean, name: path.basename(clean), layers };
}

/**
 * Read a `.clip` file and turn it into a TVMini project.
 *
 * Every raster layer of the document becomes a layer of the project that
 * carries its picture, so the whole file is brought in rather than a flat
 * preview of it.
 */
export async function readClipProject(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new ValidationError("a file path is required");
  }
  const clean = path.normalize(filePath.trim());
  if (path.extname(clean).toLowerCase() !== ".clip") {
    throw new ValidationError("choose a .clip file");
  }
  const data = Buffer.from(await fs.readFile(clean));
  const [document, layers, preview] = await Promise.all([
    readClipDocumentFromBytes(data),
    readClipLayersFromBytes(data, { includePaper: true }),
    readClipPreviewFromBytes(data).catch(() => null),
  ]);
  return {
    path: clean,
    name: path.basename(clean),
    project: clipToProject(document, layers, {
      width: preview?.width,
      height: preview?.height,
    }),
    document: {
      projectName: document.projectName,
      width: document.width,
      height: document.height,
      timeline: document.timeline,
      layers: document.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        opacity: layer.opacity,
        visible: layer.visible,
        locked: layer.locked,
        pixelDataSupported: layer.pixelDataSupported,
      })),
    },
  };
}
