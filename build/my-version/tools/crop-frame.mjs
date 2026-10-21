/**
 * The crop frame of every document of a folder.
 *
 *   node tools/crop-frame.mjs <dir-or-file> [...]
 *
 * A document can show a part of its canvas: the crop frame says how big the
 * sheet of paper is inside the canvas.
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    offset += 16 + size;
  }
  return null;
}

const files = [];
for (const arg of process.argv.slice(2)) {
  if (fs.statSync(arg).isDirectory()) {
    for (const entry of fs.readdirSync(arg)) {
      if (/\.clip$/i.test(entry)) files.push(path.join(arg, entry));
    }
  } else {
    files.push(arg);
  }
}

for (const file of files) {
  let db;
  try {
    db = await openDatabase(new Buffer(extractDatabase(fs.readFileSync(file))));
  } catch {
    continue;
  }
  try {
    const project = db.prepare("SELECT * FROM Project").get();
    const canvas = db.prepare("SELECT CanvasWidth, CanvasHeight FROM Canvas").get();
    if (!project || !canvas) continue;
    const crop = Number(project.DefaultPageUseCropFrame ?? 0);
    console.log(
      `${path.basename(file).padEnd(28)} canvas ${canvas.CanvasWidth}x${canvas.CanvasHeight} ` +
        `page ${project.DefaultPageWidth}x${project.DefaultPageHeight} ` +
        `crop ${project.DefaultPageCropWidth}x${project.DefaultPageCropHeight} ` +
        `useCrop=${crop}` +
        (crop ? "  <- the sheet of paper is smaller than the canvas" : ""),
    );
  } catch {
    // A document without the tables is not one to measure.
  } finally {
    await db.close();
  }
}
