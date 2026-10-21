import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

const b = fs.readFileSync(new URL("../public/assets/clip-template.clip", import.meta.url));
let o = 0x18;
let db = null;
while (o + 16 <= b.length) {
  const n = b.toString("ascii", o, o + 8);
  const z = Number(b.readBigUInt64BE(o + 8));
  if (n === "CHNKSQLi") { db = b.subarray(o + 16, o + 16 + z); break; }
  o += 16 + z;
}
const d = await openDatabase(new Buffer(db));
const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map((t) => t.name).join(" "));
for (const t of ["TimeLine", "Track", "TrackValueMap", "ExternalChunk", "Layer", "Canvas"]) {
  try {
    const c = d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get();
    console.log(t, "rows", c.n);
  } catch (error) {
    console.log(t, "MISSING", error.message);
  }
}
await d.close();
