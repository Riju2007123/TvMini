import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { readClipPreviewFromBytes } from "../public/core/clip.js";
import { ValidationError } from "../public/core/model.js";

export { findClipDatabase, readClipPreviewFromBytes } from "../public/core/clip.js";

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
