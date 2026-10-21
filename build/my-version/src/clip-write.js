import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "../public/core/bytes.js";
import {
  createClipBuffer as createClipBufferCore,
  setAnimationTemplateLoader,
  setTemplateLoader,
} from "../public/core/clip-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, "..", "public", "assets", "clip-template.clip");
const ANIMATION_TEMPLATE = path.join(
  __dirname,
  "..",
  "public",
  "assets",
  "clip-animation-template.clip",
);

/**
 * Build a CSP-openable .clip from a TVMini project.
 *
 * The format work lives in `public/core/clip-write.js` so the browser build
 * can reuse it. Under Node the blank template and the document with a real
 * animation in it are read from disk instead of being fetched over HTTP.
 */
export async function createClipBuffer(
  project,
  { name = "TVMini export", animation = null, validate = true } = {},
) {
  const restore = setTemplateLoader(async () => Buffer.from(await fs.readFile(TEMPLATE)));
  const restoreAnimation = setAnimationTemplateLoader(async () =>
    Buffer.from(await fs.readFile(ANIMATION_TEMPLATE)),
  );
  try {
    return await createClipBufferCore(project, { name, animation, validate });
  } finally {
    restore();
    restoreAnimation();
  }
}
