/**
 * Check the checksum of the action documents of a .clip.
 *
 *   node tools/checksum-verify.mjs file.clip [...]
 *
 * Prints, for every mixer, the checksum stored in the header and the CRC-32
 * of the document from offset 16, which is what the CSP program notes say it
 * covers.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { parseActionDocument } from "../public/core/clip-animation.js";
import { inflateSync } from "../public/core/zlib.js";

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

const TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

for (const file of process.argv.slice(2)) {
  const data = fs.readFileSync(file);
  const db = await openDatabase(new Buffer(extractDatabase(data)));
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
  const tracks = db.prepare("SELECT MainId, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all();
  await db.close();

  console.log(`\n=== ${file}`);
  let same = 0;
  let total = 0;
  for (const track of tracks) {
    for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
      const chunk = externals.get(Buffer.from(track[column]).toString("ascii"));
      if (!chunk) continue;
      const compressed = chunk.readUInt32LE(56);
      const raw = inflateSync(chunk.subarray(60, 60 + compressed));
      const doc = parseActionDocument(raw);
      if (!doc) continue;
      const stored = doc.checksum;
      const value = crc32(raw.subarray(16));
      const body = doc.body;
      const offset = doc.bodyOffset;
      total += 1;
      const ok = value === stored;
      if (ok) same += 1;
      console.log(
        `  track ${track.MainId} ${column}: stored ${stored.toString(16).padStart(8, "0")} ` +
        `crc16 ${value === null ? "-" : value.toString(16).padStart(8, "0")} ${ok ? "MATCH" : "-"} ` +
        `bodyOffset ${offset} typeCount ${doc.typeCount} body ${body.length}`,
      );
    }
  }
  console.log(`  ${same}/${total} match`);
}
