/**
 * Print the animation cut bank and the table list of a .clip, so a writer
 * knows what it has to create and what it can copy.
 *
 *   node tools/bank-probe.mjs file.clip [...]
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
    offset += 16 + size;
  }
  return null;
}

const clean = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? `blob:${Buffer.from(value).toString("hex").slice(0, 48)}`
        : typeof value === "bigint"
          ? Number(value)
          : value,
    ]),
  );

for (const file of process.argv.slice(2)) {
  const data = fs.readFileSync(file);
  const db = await openDatabase(new Buffer(extractDatabase(data)));
  console.log(`=== ${file}`);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  console.log("tables:", tables.join(", "));
  for (const name of ["AnimationCutBank", "TimeLine", "Track"]) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
    console.log(`--- ${name}: ${ddl ? "present" : "MISSING"}`);
    if (ddl) console.log(`    ${ddl.sql}`);
    if (!ddl) continue;
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    for (const row of rows) console.log("   ", JSON.stringify(clean(row)));
    if (name === "Track") {
      for (const row of rows) {
        if (Number(row.TrackKind) !== 2000) continue;
        console.log(`    TrackValueMap(${row.MainId}) =`, Buffer.from(row.TrackValueMap).toString("hex"));
      }
    }
  }
  await db.close();
}
