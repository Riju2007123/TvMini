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
const data = fs.readFileSync(path);
const db = await openDatabase(new Buffer(extractDatabase(data)));

// external chunk lookup
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

const tracks = db.prepare("SELECT MainId, TrackKind, TrackActionMixer, TrackActionMixer2, TrackValueMap FROM Track").all();
for (const track of tracks) {
  for (const [which, col] of [["mixer", "TrackActionMixer"], ["mixer2", "TrackActionMixer2"]]) {
    const id = Buffer.from(track[col]).toString("ascii");
    const chunk = externalById.get(id);
    if (!chunk) { console.log(`track ${track.MainId} ${which}: no blob (${id})`); continue; }
    const doc = readActionBlob(chunk);
    if (!doc) { console.log(`track ${track.MainId} ${which}: not an action doc`); continue; }
    console.log(`\n########## track ${track.MainId} ${which} kind=${track.TrackKind}`);
    console.log(`  version=${doc.version} codec=${doc.codec} poolSize=${doc.poolSize} bodyLen=${doc.body.length}`);
    console.log(`  POOL (${doc.pool.length}):`);
    doc.pool.forEach((p, i) => console.log(`    [${i}] ${JSON.stringify(p)}`));
    console.log(`  BODY hex:`);
    const b = Buffer.from(doc.body);
    for (let i = 0; i < b.length; i += 32) {
      const slice = b.subarray(i, Math.min(i + 32, b.length));
      const hexs = [...slice].map((x) => x.toString(16).padStart(2, "0")).join(" ");
      console.log(`   ${String(i).padStart(5)} ${hexs}`);
    }
  }
}
await db.close();
