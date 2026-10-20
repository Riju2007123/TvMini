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

const dbBytes = new Buffer(extractDatabase(fs.readFileSync(process.argv[2])));
console.log("sqlite bytes:", dbBytes.length, "header:", dbBytes.subarray(0, 16).toString("hex"));

// Raw page-1 header info (SQLite on-disk header starts at byte 0 of the database)
console.log("page1 magic:", dbBytes.subarray(0, 16).toString("latin1").replace(/[^\x20-\x7e]/g, "."));
const pageSize = dbBytes.readUInt16BE(16) === 1 ? 65536 : dbBytes.readUInt16BE(16);
console.log("page size:", pageSize, "file change counter:", dbBytes.readUInt32BE(24));
console.log("DB size in pages:", dbBytes.readUInt32BE(28));
console.log("freelist pages:", dbBytes.readUInt32BE(36));
console.log("schema cookie:", dbBytes.readUInt32BE(40));
console.log("text encoding:", dbBytes.readUInt32BE(56));

const db = await openDatabase(dbBytes);
for (const table of ["Project", "Canvas", "CanvasPreview", "CanvasItem", "CanvasItemBank", "Layer", "LayerComp", "LayerCompManager", "LayerThumbnail", "Mipmap", "MipmapInfo", "Offscreen", "TimeLine", "Track", "TimeLapseManager", "TimeLapseRecord", "TimeLapseBlob", "AnimationCutBank", "ElemScheme", "ExternalChunk", "ElemScheme", "RemovedExternal", "ParamScheme"]) {
  try {
    const n = Number(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c);
    console.log(`  ${table}: ${n} rows`);
  } catch (e) { console.log(`  ${table}: ERROR ${e.message}`); }
}
for (const pragma of ["PRAGMA integrity_check(60)", "PRAGMA quick_check(60)", "PRAGMA journal_mode", "PRAGMA user_version"]) {
  try {
    const rows = db.prepare(pragma).all();
    console.log(`  ${pragma} ->`, rows.map(r => JSON.stringify(Object.values(r))).join(", ").slice(0, 400));
  } catch (e) { console.log(`  ${pragma} -> ERROR ${e.message}`); }
}
await db.close();
