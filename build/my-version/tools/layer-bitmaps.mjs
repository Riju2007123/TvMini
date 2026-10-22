/**
 * Save the bitmap of every layer of a .clip, and where it sits.
 *
 *   node tools/layer-bitmaps.mjs file.clip outDir
 */
import fs from "node:fs";
import path from "node:path";
import { readClipLayersFromBytes } from "../public/core/clip.js";
import { encodeRgbaPng } from "../public/core/png.js";

const [file, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const layers = await readClipLayersFromBytes(fs.readFileSync(file), { includePaper: true });
for (const layer of layers) {
  const shown = layer.width * layer.height * 4;
  const got = layer.pixels?.length ?? 0;
  const note = got === shown ? "" : ` (pixels ${got} ≠ canvas ${shown})`;
  const width = layer.width;
  const rows = Math.floor(got / 4 / width);
  if (got === 0) { console.log(`${layer.id} "${layer.name}" has no pixels${note}`); continue; }
  const out = path.join(outDir, `${layer.id}-${layer.name.replace(/[^\w.-]/g, "_")}.png`);
  fs.writeFileSync(out, encodeRgbaPng(width, rows, layer.pixels.subarray(0, width * rows * 4)));
  console.log(`${layer.id} "${layer.name}" ${layer.width}x${layer.height} at ${layer.offsetX},${layer.offsetY}${note} -> ${out} (${width}x${rows} written)`);
}
