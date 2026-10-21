import fs from "node:fs";
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

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const canvas = db.prepare("SELECT CanvasWidth, CanvasHeight FROM Canvas").get();
console.log(`canvas ${canvas.CanvasWidth} x ${canvas.CanvasHeight}`);

for (const row of db.prepare("SELECT * FROM Layer ORDER BY MainId").all()) {
  const offscreen = db
    .prepare(
      "SELECT o.Attribute, o.BlockData FROM Mipmap m " +
        "JOIN MipmapInfo mi ON mi.MainId = m.BaseMipmapInfo " +
        "JOIN Offscreen o ON o.MainId = mi.Offscreen WHERE m.MainId = ?",
    )
    .get(row.LayerRenderMipmap);
  let size = "";
  if (offscreen?.Attribute) {
    const hex = Buffer.from(offscreen.Attribute).toString("hex");
    size = ` offscreen ${hex.slice(0, 24)}`;
  }
  console.log(
    `${String(row.MainId).padStart(3)} ${JSON.stringify(row.LayerName).padEnd(20)} type=${String(row.LayerType).padStart(4)} ` +
      `offset=${row.LayerOffsetX},${row.LayerOffsetY} ` +
      `renderOffset=${row.LayerRenderOffscrOffsetX},${row.LayerRenderOffscrOffsetY} ` +
      `maskOffset=${row.LayerMaskOffsetX},${row.LayerMaskOffsetY} ` +
      `maskRenderOffset=${row.LayerMaskOffscrOffsetX},${row.LayerMaskOffscrOffsetY} ` +
      `w=${row.LayerWidth ?? "-"} h=${row.LayerHeight ?? "-"}${size}`,
  );
}
await db.close();
