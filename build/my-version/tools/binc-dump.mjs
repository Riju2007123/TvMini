/**
 * Print the words of one track's action document, with the pool name of each
 * word when it is a pool index.
 *
 *   node tools/binc-dump.mjs file.clip <trackId> [mixer]
 *
 * `mixer` is 1 or 2 and defaults to 2. This is how the layout of the document
 * was mapped: offset, bytes, number, and what the number names.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob } from "../public/core/clip-animation.js";

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

const file = process.argv[2];
const trackId = Number(process.argv[3]);
const mixer = String(process.argv[4] ?? "2");
const data = fs.readFileSync(file);
const db = await openDatabase(new Buffer(extractDatabase(data)));

const column = mixer === "1" ? "TrackActionMixer" : "TrackActionMixer2";
const row = db.prepare(`SELECT ${column} AS id FROM Track WHERE MainId = ?`).get(trackId);
const externals = new Map();
for (const r of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta" && offset === Number(r.Offset)) {
      externals.set(Buffer.from(r.ExternalID).toString("ascii"), data.subarray(offset + 16, offset + 16 + size));
      break;
    }
    offset += 16 + size;
  }
}
await db.close();

const doc = readActionBlob(externals.get(Buffer.from(row.id).toString("ascii")));
const { body, pool } = doc;
console.log(`track ${trackId} mixer ${mixer}: body ${body.length} bytes, pool ${pool.length}`);
pool.forEach((name, index) => console.log(`  pool[${String(index).padStart(2)}] ${JSON.stringify(name)}`));
console.log("");

for (let at = 0; at + 4 <= body.length; at += 4) {
  const word = body.readUInt32LE(at);
  const name = word < pool.length ? `  pool[${word}] ${JSON.stringify(pool[word])}` : "";
  const asDouble = at + 8 <= body.length ? body.readDoubleLE(at) : NaN;
  const double = Number.isFinite(asDouble) && Math.abs(asDouble) < 1e7 && asDouble !== 0
    ? `  d=${Number(asDouble.toFixed(4))}`
    : "";
  console.log(`${String(at).padStart(5)}  ${word.toString(10).padStart(12)}${name}${double}`);
}
