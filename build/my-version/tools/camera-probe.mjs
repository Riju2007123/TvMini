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

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));

const project = db.prepare("SELECT * FROM Project").get();
console.log("Project:", JSON.stringify(Object.fromEntries(
  Object.entries(project).map(([k, v]) => [k, v instanceof Uint8Array ? `blob:${v.length}` : typeof v === "bigint" ? Number(v) : v]),
)));
const canvas = db.prepare("SELECT * FROM Canvas").get();
console.log("Canvas:", JSON.stringify(Object.fromEntries(
  Object.entries(canvas).map(([k, v]) => [k, v instanceof Uint8Array ? `blob:${v.length}` : typeof v === "bigint" ? Number(v) : v]),
)));

const columns = db.prepare("PRAGMA table_info(Layer)").all().map((c) => c.name);
console.log("\nLayer columns:", columns.join(" "));
const camera = db.prepare("SELECT * FROM Layer WHERE LayerType = 512").get();
if (camera) {
  console.log("\ncamera layer:");
  for (const [key, value] of Object.entries(camera)) {
    if (value === null || value === undefined) continue;
    console.log(`  ${key} = ${value instanceof Uint8Array ? `blob:${Buffer.from(value).toString("hex").slice(0, 40)}` : value}`);
  }
}
await db.close();
