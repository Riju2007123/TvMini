/**
 * The size of the canvas and of the page of every document of a folder.
 *
 *   node tools/canvas-sizes.mjs <dir-or-file> [...]
 *
 * A Clip Studio document has two sizes: the canvas (the whole pasteboard) and
 * the page (the sheet of paper on it). The pictures of the layers are placed
 * on the canvas, and the camera works in canvas coordinates.
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { parseAttribute } from "../public/core/clip-blocks.js";

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
    const canvas = db.prepare("SELECT CanvasWidth, CanvasHeight FROM Canvas").get();
    const project = db.prepare("SELECT DefaultPageWidth, DefaultPageHeight FROM Project").get();
    if (!canvas || !project) continue;
    // The size of the picture of the first drawing layer.
    let raster = "";
    for (const row of db.prepare("SELECT MainId, LayerName, LayerType, LayerRenderMipmap FROM Layer").all()) {
      if (Number(row.LayerType) !== 1) continue;
      const info = db
        .prepare(
          "SELECT mi.Offscreen FROM Mipmap m JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo WHERE m.MainId = ?",
        )
        .get(row.LayerRenderMipmap);
      const offscreen = info ? db.prepare("SELECT Attribute FROM Offscreen WHERE MainId = ?").get(info.Offscreen) : null;
      if (!offscreen?.Attribute) continue;
      const attribute = parseAttribute(Buffer.from(offscreen.Attribute));
      raster = ` raster ${attribute.width}x${attribute.height}`;
      break;
    }
    const same = canvas.CanvasWidth === project.DefaultPageWidth && canvas.CanvasHeight === project.DefaultPageHeight;
    console.log(
      `${path.basename(file).padEnd(28)} canvas ${String(canvas.CanvasWidth).padStart(5)}x${String(canvas.CanvasHeight).padEnd(5)} ` +
        `page ${String(project.DefaultPageWidth).padStart(5)}x${String(project.DefaultPageHeight).padEnd(5)}${same ? "  (the same)" : ""}${raster}`,
    );
  } catch {
    // A document without the tables is not one to measure.
  } finally {
    await db.close();
  }
}
