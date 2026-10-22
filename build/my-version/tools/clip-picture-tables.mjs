/**
 * The tables that carry the picture of a layer, and their columns.
 *
 *   node tools/clip-picture-tables.mjs file.clip
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

const db = await openDatabase(new Buffer(extractDatabase(fs.readFileSync(process.argv[2]))));
for (const table of ["MipmapInfo", "Offscreen", "LayerComp"]) {
  const columns = db.prepare(`PRAGMA table_info([${table}])`).all().map((r) => r.name);
  console.log(`${table}: ${columns.join(", ")}`);
}
for (const row of db.prepare("SELECT * FROM MipmapInfo LIMIT 2").all()) {
  const plain = {};
  for (const [key, value] of Object.entries(row)) {
    plain[key] = value instanceof Uint8Array ? `<${value.length} bytes>` : value;
  }
  console.log(JSON.stringify(plain));
}
await db.close();
