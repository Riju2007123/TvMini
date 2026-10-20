import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

function extractDatabase(data) {
  if (data.toString("ascii", 0, 8) !== "CSFCHUNK") return { error: "no CSFCHUNK magic" };
  const chunks = [];
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    if (!/^[\x20-\x7e]{8}$/.test(name)) { chunks.push({ name: "BAD:" + name, size: 0 }); break; }
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(size) || offset + 16 + size > data.length) { chunks.push({ name, size: "TRUNCATED" }); break; }
    chunks.push({ name, size });
    if (name === "CHNKSQLi") return { chunks, sqlitedb: data.subarray(offset + 16, offset + 16 + size) };
    offset += 16 + size;
  }
  return { chunks };
}

for (const path of process.argv.slice(2)) {
  console.log("============ " + path);
  const data = fs.readFileSync(path);
  console.log("magic:", data.subarray(0, 8).toString("latin1"), "size:", data.length);
  const info = extractDatabase(new Buffer(data));
  if (info.error) { console.log("error:", info.error); continue; }
  console.log("chunks:", info.chunks.map(c => `${c.name}(${c.size})`).join(" "));
  if (!info.sqlitedb) { console.log("no CHNKSQLi chunk"); continue; }
  const db = await openDatabase(info.sqlitedb);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log("tables:", tables.map(t => t.name).join(", "));
  for (const name of ["CanvasPreview", "CanvasInfo", "FirstBrowseAdjustData"]) {
    try {
      const tinfo = tables.find(t => t.name === name);
      if (!tinfo) continue;
      const cols = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
      const count = db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
      console.log(`  [${name}] rows=${count} cols=${cols.join(",")}`);
    } catch (e) { console.log(`  [${name}] ${e.message}`); }
  }
  await db.close();
}
