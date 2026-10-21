import fs from "node:fs";
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

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const canvas = db.prepare("SELECT CanvasWidth, CanvasHeight FROM Canvas").get();
const project = db.prepare("SELECT DefaultPageWidth, DefaultPageHeight FROM Project").get();
console.log(`canvas ${canvas.CanvasWidth} x ${canvas.CanvasHeight}, page ${project.DefaultPageWidth} x ${project.DefaultPageHeight}`);

for (const row of db.prepare("SELECT * FROM Layer ORDER BY MainId").all()) {
  const offscreen = db
    .prepare(
      "SELECT o.Attribute FROM Mipmap m " +
        "JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo " +
        "JOIN Offscreen o ON o.MainId = mi.Offscreen WHERE m.MainId = ?",
    )
    .get(row.LayerRenderMipmap);
  let size = "";
  if (offscreen?.Attribute) {
    const attribute = parseAttribute(Buffer.from(offscreen.Attribute));
    size = ` raster ${attribute.width}x${attribute.height}`;
  }
  console.log(
    `${String(row.MainId).padStart(3)} ${JSON.stringify(row.LayerName).padEnd(20)} ` +
      `offset=${row.LayerOffsetX},${row.LayerOffsetY} ` +
      `renderOffset=${row.LayerRenderOffscrOffsetX},${row.LayerRenderOffscrOffsetY}${size}`,
  );
}
await db.close();
