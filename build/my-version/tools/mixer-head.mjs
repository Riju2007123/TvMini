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

const data = fs.readFileSync(process.argv[2]);
const trackId = Number(process.argv[3] ?? 12);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const track = db.prepare("SELECT * FROM Track WHERE MainId = ?").get(trackId);
const offsets = new Map();
for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  offsets.set(Buffer.from(row.ExternalID).toString("ascii"), Number(row.Offset));
}
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
await db.close();

console.log("tables:", rows.map((row) => row.name).join(" "));
const valueMap = Buffer.from(track.TrackValueMap);
console.log(`TrackValueMap ${valueMap.length} bytes: ${valueMap.toString("hex")}`);
console.log(`  utf16be: ${valueMap.toString("utf16le")}`);

for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
  const id = Buffer.from(track[column]).toString("ascii");
  const offset = offsets.get(id);
  const size = Number(data.readBigUInt64BE(offset + 8));
  const payload = data.subarray(offset + 16, offset + 16 + size);
  console.log(`\n${column} id=${id} chunkOff=${offset} chunkSize=${size} columnSize=${track[column + "Size"]}`);
  console.log(`  head: ${payload.subarray(0, 60).toString("hex")}`);
  console.log(`  ascii: ${JSON.stringify(payload.subarray(0, 60).toString("latin1"))}`);
  console.log(`  [48] u64be=${Number(payload.readBigUInt64BE(48))}  [4] u32le=${payload.readUInt32LE(4)}  [56] u32le=${payload.readUInt32LE(56)}  payload=${payload.length}`);
}
