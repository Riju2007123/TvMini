/**
 * Compare the action documents of two tracks, word by word.
 *
 *   node tools/body-diff.mjs file.clip <trackA> <trackB> [mixer]
 *
 * The words that are the same are the fixed structure of a document; the
 * words that differ are the values a writer has to fill in.
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
const a = Number(process.argv[3]);
const b = Number(process.argv[4]);
const mixer = String(process.argv[5] ?? "2");
const data = fs.readFileSync(file);
const db = await openDatabase(new Buffer(extractDatabase(data)));

const externals = new Map();
for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta" && offset === Number(row.Offset)) {
      externals.set(Buffer.from(row.ExternalID).toString("ascii"), data.subarray(offset + 16, offset + 16 + size));
      break;
    }
    offset += 16 + size;
  }
}
const column = mixer === "1" ? "TrackActionMixer" : "TrackActionMixer2";
const read = (id) => {
  const row = db.prepare(`SELECT ${column} AS mixer FROM Track WHERE MainId = ?`).get(id);
  return readActionBlob(externals.get(Buffer.from(row.mixer).toString("ascii")));
};
const left = read(a);
const right = read(b);
await db.close();

console.log(`A: track ${a}, ${left.body.length} bytes; B: track ${b}, ${right.body.length} bytes`);
console.log(`pool equal: ${JSON.stringify(left.pool) === JSON.stringify(right.pool)}`);

const short = Math.min(left.body.length, right.body.length);
let runs = 0;
for (let at = 0; at < short; at += 4) {
  const one = left.body.readUInt32LE(at);
  const two = right.body.readUInt32LE(at);
  if (one === two) continue;
  runs += 1;
  if (runs > 80) break;
  const name = (word) => (word < left.pool.length ? `"${left.pool[word]}"` : String(word));
  console.log(`  ${String(at).padStart(5)}  A=${name(one)}  B=${name(two)}`);
}
console.log(`differing words: ${runs}`);
