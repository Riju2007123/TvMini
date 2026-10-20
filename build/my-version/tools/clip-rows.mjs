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

const path = process.argv[2];
const db = await openDatabase(new Buffer(extractDatabase(fs.readFileSync(path))));
const show = (label, rows) => {
  console.log(`-- ${label}`);
  for (const row of rows) {
    const clean = {};
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (typeof v === "string" && v.length > 80) clean[k] = v.slice(0, 80) + `…(${v.length})`;
      else if (v instanceof Uint8Array) clean[k] = `<bytes ${v.length}>`;
      else if (typeof v === "bigint") clean[k] = Number(v);
      else clean[k] = v;
    }
    console.log("   ", JSON.stringify(clean));
  }
  if (rows.length === 0) console.log("    (empty)");
};

const tables = ["Project", "Canvas", "CanvasPreview", "CanvasItemBank", "TimeLine", "Track"];
for (const t of tables) {
  try { show(t, db.prepare(`SELECT * FROM ${t} LIMIT 6`).all()); }
  catch (e) { console.log(`-- ${t}: ERROR ${e.message}`); }
}
await db.close();
