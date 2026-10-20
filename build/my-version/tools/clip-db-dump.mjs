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

for (const path of process.argv.slice(2)) {
  console.log("============ " + path);
  const db = await openDatabase(new Buffer(fs.readFileSync(path)));
  for (const sql of [
    "SELECT * FROM Project LIMIT 3",
    "SELECT * FROM Canvas LIMIT 5",
    "SELECT MainId,CanvasId,ImageType,ImageWidth,ImageHeight,length(ImageData) AS pngLen FROM CanvasPreview LIMIT 5",
    "SELECT COUNT(*) AS layerRows FROM Layer",
    "SELECT COUNT(*) AS timelineRows FROM TimeLine",
    "SELECT COUNT(*) AS trackRows FROM Track",
    "SELECT COUNT(*) AS canvasItemRows FROM CanvasItem",
    "SELECT COUNT(*) AS mipmapRows FROM Mipmap",
    "SELECT COUNT(*) AS mipmapInfoRows FROM MipmapInfo",
    "SELECT * FROM MipmapInfo LIMIT 8",
    "SELECT COUNT(*) AS externalChunkRows FROM ExternalChunk",
    "SELECT * FROM ExternalTableAndColumnName LIMIT 10",
  ]) {
    try {
      const rows = db.prepare(sql).all();
      for (const row of rows) {
        for (const k of Object.keys(row)) {
          if (typeof row[k] === "string" && row[k].length > 64) row[k] = row[k].slice(0, 64) + "…(" + row[k].length + ")";
          if (row[k] instanceof Uint8Array) row[k] = `<bytes ${row[k].length}>`;
          if (typeof row[k] === "bigint") row[k] = Number(row[k]);
        }
        console.log("   ", JSON.stringify(row));
      }
      if (rows.length === 0) console.log("    (0 rows)");
    } catch (e) {
      console.log("   !", sql, "->", e.message);
    }
  }
  await db.close();
}
