/**
 * Print the rows a written animation needs to copy: the animation folder, one
 * of its cells, the cut bank and one track.
 *
 *   node tools/layer-probe.mjs file.clip
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

const [file, ...extra] = process.argv.slice(2);
const data = fs.readFileSync(file);
const db = await openDatabase(new Buffer(extractDatabase(data)));

const show = (table, where) => {
  const row = db.prepare(`SELECT * FROM "${table}" ${where ?? ""} LIMIT 1`).get();
  console.log(`\n=== ${table} ${where ?? ""}`);
  if (!row) return console.log("(no row)");
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array
      ? `blob(${value.length}) ${Buffer.from(value).toString("hex").slice(0, 40)}`
      : typeof value === "bigint" ? Number(value) : value;
  }
  console.log(JSON.stringify(out));
};

for (const name of ["TimeLine", "Track", "AnimationCutBank"]) {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name);
  console.log(`\n### ${name}\n${schema?.sql ?? "MISSING"}`);
}
for (const name of ["TimeLine", "Track", "AnimationCutBank"]) show(name);

// The animation folder of track 13 and the cells under it.
const folder = db.prepare("SELECT * FROM Layer WHERE MainId = 17").get();
show("Layer", "WHERE MainId = 17");

const chain = [];
let child = Number(folder.LayerFirstChildIndex);
while (child) {
  const row = db.prepare("SELECT MainId, LayerName, LayerNextIndex, LayerFolder, AnimationFolder, LayerType FROM Layer WHERE MainId = ?").get(child);
  chain.push(row);
  child = Number(row.LayerNextIndex);
}
console.log("\ncells under layer 17:", JSON.stringify(chain));

console.log("\ncolumns of the blank template:");
const template = fs.readFileSync(new URL("../public/assets/clip-template.clip", import.meta.url));
const templateDb = await openDatabase(new Buffer(extractDatabase(template)));
for (const name of ["Layer", "AnimationCutBank"]) {
  const columns = templateDb.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name);
  console.log(name, columns.includes("AnimationFolder") ? "HAS AnimationFolder" : "no AnimationFolder");
  if (name === "Layer") console.log("  " + columns.join(" "));
}
await templateDb.close();
await db.close();
