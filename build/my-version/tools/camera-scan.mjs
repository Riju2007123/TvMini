// Report which .clip files carry a camera: a Track of kind 2005 and/or a
// Layer of type 512. Usage: node tools/camera-scan.mjs <files...>
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

for (const path of process.argv.slice(2)) {
  let data;
  try { data = fs.readFileSync(path); } catch { continue; }
  const sql = extractDatabase(data);
  if (!sql) continue;
  let db;
  try { db = await openDatabase(new Buffer(sql)); } catch { continue; }
  try {
    const kinds = db.prepare("SELECT TrackKind, COUNT(*) AS n FROM Track GROUP BY TrackKind").all();
    const has2005 = kinds.some((k) => Number(k.TrackKind) === 2005);
    const layers = db.prepare("SELECT COUNT(*) AS n FROM Layer WHERE LayerType = 512").get();
    if (has2005 || Number(layers.n) > 0) {
      console.log(`${path}`);
      console.log(`   track kinds: ${kinds.map((k) => `${k.TrackKind}x${k.n}`).join(", ")}`);
      console.log(`   camera layers (512): ${layers.n}`);
    }
  } catch (e) {
    console.log(`${path}: error ${e.message}`);
  } finally {
    await db.close();
  }
}
