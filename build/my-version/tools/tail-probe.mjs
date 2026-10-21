// Focused probe: annotate the unaligned tail of the 0100 mixer of track 2
// (the cel track); show words AND u16 splits from a chosen byte offset.
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
    if (!/^[\x20-\xe]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

const path = process.argv[2];
const start = process.argv[3] ? Number(process.argv[3]) : 350;
const data = fs.readFileSync(path);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const externalById = new Map();
for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  const id = Buffer.from(row.ExternalID).toString("ascii");
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta" && offset === Number(row.Offset)) {
      externalById.set(id, data.subarray(offset + 16, offset + 16 + size));
      break;
    }
    offset += 16 + size;
  }
}
const tracks = db.prepare("SELECT MainId, TrackKind, TrackActionMixer FROM Track ORDER BY MainId").all();
const track = tracks[1]; // the cel track (kind 2000)
const doc = readActionBlob(externalById.get(Buffer.from(track.TrackActionMixer).toString("ascii")));
const pool = doc.pool;
const body = Buffer.from(doc.body);
console.log(`kind=${track.TrackKind} body=${body.length}`);
for (let at = start; at < body.length; at += 4) {
  if (at + 4 > body.length) break;
  const v = body.readUInt32LE(at);
  let text = `  @${String(at).padStart(4)}: ${String(v).padStart(10)}`;
  if (v < pool.length) text += ` pool='${pool[v]}'`;
  // u16-leaves interpretation
  const u0 = body.readUInt16LE(at);
  const u1 = body.readUInt16LE(at + 2);
  if (v >= 0x1000) text += `   u16s=(${u0},${u1})`;
  console.log(text);
}
await db.close();
