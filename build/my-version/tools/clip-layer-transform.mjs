/**
 * The columns of the Layer table that say where a layer sits.
 *
 *   node tools/clip-layer-transform.mjs file.clip
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

const pattern = /offset|scale|rotat|position|transform|ratio|angle|turn|zoom|pivot|anchor|place|align|matrix|expand/i;

for (const file of process.argv.slice(2)) {
  const db = await openDatabase(new Buffer(extractDatabase(fs.readFileSync(file))));
  const columns = db.prepare("PRAGMA table_info([Layer])").all().map((row) => row.name);
  const wanted = columns.filter((name) => pattern.test(name));
  console.log(`============ ${file}`);
  console.log(`  ${wanted.length} column(s): ${wanted.join(", ")}`);
  for (const row of db.prepare("SELECT * FROM Layer").all()) {
    const parts = wanted
      .filter((name) => row[name] !== null && row[name] !== undefined && row[name] !== 0 && row[name] !== "")
      .map((name) => `${name}=${row[name] instanceof Uint8Array ? `<${row[name].length}b>` : row[name]}`);
    if (parts.length) console.log(`  "${row.LayerName}": ${parts.join(" ")}`);
  }
  await db.close();
}
