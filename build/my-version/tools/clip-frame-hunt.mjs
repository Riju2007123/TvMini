/**
 * Look for the frame a document opens on.
 *
 *   node tools/clip-frame-hunt.mjs a.clip b.clip
 *
 * Every column of every table whose name mentions a frame is printed with
 * its value, so the place Clip Studio Paint keeps the current frame of the
 * timeline can be seen.
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

const show = (value) => {
  if (value === null || value === undefined) return "-";
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "bigint") return String(Number(value));
  return String(value);
};

for (const file of process.argv.slice(2)) {
  console.log(`============ ${file}`);
  const data = fs.readFileSync(file);
  const database = await openDatabase(new Buffer(extractDatabase(data)));
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  for (const table of tables) {
    let columns;
    try {
      columns = database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
    } catch {
      continue;
    }
    const wanted = columns.filter((name) => /frame/i.test(name));
    if (!wanted.length) continue;
    const rows = database.prepare(`SELECT * FROM "${table}"`).all();
    for (const row of rows) {
      const parts = wanted
        .filter((name) => row[name] !== null && row[name] !== undefined)
        .map((name) => `${name}=${show(row[name])}`);
      if (parts.length) console.log(`  ${table}: ${parts.join(" ")}`);
    }
  }
  await database.close();
}
