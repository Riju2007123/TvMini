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

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const wanted = ["TimeLine", "Track", "TrackValueMap", "AnimationCutBank"];
for (const name of wanted) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  console.log(`\n=== ${name}`);
  console.log(row ? row.sql : "MISSING");
  if (!row) continue;
  const rows = db.prepare(`SELECT * FROM "${name}" LIMIT 3`).all();
  for (const record of rows) {
    const out = {};
    for (const [key, value] of Object.entries(record)) {
      out[key] = value instanceof Uint8Array
        ? `Uint8Array(${value.length}) ${Buffer.from(value).toString("hex").slice(0, 64)}`
        : typeof value === "bigint" ? Number(value) : value;
    }
    console.log(JSON.stringify(out));
  }
}
await db.close();
