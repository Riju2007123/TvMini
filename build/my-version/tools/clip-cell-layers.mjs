/**
 * What kind of layer the cells of an animation folder are.
 *
 *   node tools/clip-cell-layers.mjs file.clip
 *
 * Every animation folder is listed with its cells: the kind of layer the
 * cell is (a raster layer, or a folder that holds layers of its own), and
 * whether it carries a picture.
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

const KIND = { 1: "raster", 256: "root folder", 800: "information", 1584: "paper" };

const file = process.argv[2];
const data = fs.readFileSync(file);
const db = await openDatabase(new Buffer(extractDatabase(data)));

const layers = db.prepare("SELECT * FROM Layer").all();
const byId = new Map(layers.map((row) => [Number(row.MainId), row]));
const childrenOf = (row) => {
  const list = [];
  let id = Number(row.LayerFirstChildIndex ?? 0);
  const seen = new Set();
  while (id && byId.has(id) && !seen.has(id)) {
    seen.add(id);
    list.push(byId.get(id));
    id = Number(byId.get(id).LayerNextIndex ?? 0);
  }
  return list;
};

// A layer carries a picture when it has a mipmap of its own.
const pictures = new Set(
  db
    .prepare("SELECT LayerId FROM MipmapInfo")
    .all()
    .map((row) => Number(row.LayerId))
    .filter((id) => id),
);

const counts = new Map();
for (const row of layers) {
  const kind = KIND[Number(row.LayerType)] ?? `type ${row.LayerType}`;
  counts.set(kind, (counts.get(kind) || 0) + 1);
}

console.log(`${file}`);
console.log(`  ${layers.length} layers: ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}`);

for (const folder of layers.filter((row) => Number(row.AnimationFolder) === 1)) {
  console.log(`  animation folder "${folder.LayerName}":`);
  for (const cell of childrenOf(folder)) {
    const kind = KIND[Number(cell.LayerType)] ?? `type ${cell.LayerType}`;
    const folderBit = Number(cell.LayerFolder) ? " (folder)" : "";
    const picture = pictures.has(Number(cell.MainId)) ? "with a picture" : "no picture";
    const inside = childrenOf(cell).length;
    console.log(
      `    cell "${cell.LayerName}": ${kind}${folderBit}, ${picture}` +
        (inside ? `, holds ${inside} layer(s)` : ""),
    );
  }
}
await db.close();
