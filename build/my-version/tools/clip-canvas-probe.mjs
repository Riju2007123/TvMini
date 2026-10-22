/**
 * The settings of the canvas and the page of a `.clip`.
 *
 *   node tools/clip-canvas-probe.mjs a.clip b.clip
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

const plain = (value) => (typeof value === "bigint" ? Number(value) : value);

for (const file of process.argv.slice(2)) {
  const database = await openDatabase(new Buffer(extractDatabase(fs.readFileSync(file))));
  const canvas = database.prepare("SELECT * FROM Canvas").all()[0] ?? {};
  const project = database.prepare("SELECT * FROM Project").all()[0] ?? {};
  const picked = (row, pattern) =>
    Object.fromEntries(
      Object.entries(row)
        .filter(([name, value]) => pattern.test(name) && value !== null && value !== undefined)
        .map(([name, value]) => [name, value instanceof Uint8Array ? `<${value.length} bytes>` : plain(value)]),
    );
  console.log(`============ ${file}`);
  console.log(`  canvas: ${JSON.stringify(picked(canvas, /^(CanvasWidth|CanvasHeight|CanvasResolution|CanvasUnit|TimeLineFrameDisplay|TimeLineEditMode|CropFrameOptionFlag|CropFrameWidth|CropFrameHeight|CropFrameCropOffset)/))}`);
  console.log(`  page:   ${JSON.stringify(picked(project, /^(DefaultPage)/))}`);
  await database.close();
}
