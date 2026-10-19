import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "../public/core/bytes.js";
import {
  createClipBuffer as createClipBufferCore,
  setTemplateLoader,
} from "../public/core/clip-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, "..", "public", "assets", "clip-template.clip");

/**
 * Build a CSP-openable .clip from a TVMini project.
 *
 * The format work lives in `public/core/clip-write.js` so the browser build
 * can reuse it. Under Node the blank template is read from disk instead of
 * being fetched over HTTP.
 */
export async function createClipBuffer(project, { name = "TVMini export" } = {}) {
  const restore = setTemplateLoader(async () => Buffer.from(await fs.readFile(TEMPLATE)));
  try {
    return await createClipBufferCore(project, { name });
  } finally {
    restore();
  }
}
