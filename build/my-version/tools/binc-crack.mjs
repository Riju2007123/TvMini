// Word-level dump of mixer document bodies with pool annotations.
// Usage: node tools/binc-crack.mjs <file.clip> [trackOrdinal(0-based)] [startWord]
import fs from "node:fs";
import zlib from "node:zlib";
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
const ordinal = process.argv[3] ? Number(process.argv[3]) : 0;
const startWord = process.argv[4] ? Number(process.argv[4]) : 0;
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

const tracks = db.prepare("SELECT MainId, TrackKind, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all();
for (const [index, track] of tracks.entries()) {
  if (index !== ordinal) continue;
  for (const col of ["TrackActionMixer", "TrackActionMixer2"]) {
    const id = Buffer.from(track[col]).toString("ascii");
    const blob = externalById.get(id);
    if (!blob) continue;
    let doc;
    try { doc = readActionBlob(blob); } catch (e) { console.log(`track ${track.MainId} ${col}: unread (${e.message})`); continue; }
    const raw = zlib.inflateSync(blob.subarray(60, 60 + doc.compressed));
    console.log(`track ${track.MainId} ${col} kind=${track.TrackKind} doc="${doc.version}" pool=${doc.pool.length} body=${doc.body.length} raw=${raw.length} stored=${(doc.checksum >>> 0).toString(16)} crc16=0x${zlib.crc32(raw.subarray(16)).toString(16)}`);
    console.log("pool:", doc.pool.map((s, i) => `${i}:"${s}"`).join(" "));
    const body = Buffer.from(doc.body);
    for (let i = startWord * 4; i + 4 <= body.length; i += 4) {
      const v = body.readUInt32LE(i);
      let text = `  w${String(i / 4).padStart(3)} @${String(i).padStart(4)}: ${String(v).padStart(10)}`;
      if (v < doc.pool.length) text += ` ="${doc.pool[v]}"`;
      if (i + 8 <= body.length) {
        const d = body.readDoubleLE(i);
        if (Number.isFinite(d) && d !== 0 && Math.abs(d) < 1e12) text += `  (f64@here≈${d})`;
        const f = body.readFloatLE(i);
        if (Number.isFinite(f) && Math.abs(f) > 1e-6 && Math.abs(f) < 1e12) text += `  (f32≈${f.toFixed(3)})`;
      }
      console.log(text);
    }
    const tailN = body.length % 4;
    if (tailN) console.log(`  tail(${tailN}B): ${body.subarray(body.length - tailN).toString("hex")}`);
  }
}
await db.close();
