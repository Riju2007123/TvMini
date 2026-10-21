// Probe: (1) checksum formula of the "cmt " document header;
//        (2) local record patterns for the fields the writer must edit:
//            TimeClip Start/End/Rate, FCurve Type/Frame/Value/slopes/Interp,
//            Tag (cel sequence). Prints every match position with context.
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

function fnv1a(bytes, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function sum32(bytes) {
  let h = 0 >>> 0;
  for (const b of bytes) h = (h + b) >>> 0;
  return h >>> 0;
}

const path = process.argv[2];
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

for (const track of db.prepare("SELECT MainId, TrackKind, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all()) {
  for (const [which, col] of [["mixer", "TrackActionMixer"], ["mixer2", "TrackActionMixer2"]]) {
    const externalId = Buffer.from(track[col]).toString("ascii");
    const blob = externalById.get(externalId);
    if (!blob) continue;
    const doc = readActionBlob(blob);
    if (!doc) continue;
    const raw = zlib.inflateSync(blob.subarray(60, 60 + doc.compressed));
    const stored = doc.checksum >>> 0;

    // checksum hypothesis tests
    const poolBytes = Buffer.concat(doc.pool.map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)])));
    const tests = {
      "crc(pool+body)": zlib.crc32(Buffer.concat([poolBytes, doc.body])) >>> 0,
      "crc(body)": zlib.crc32(doc.body) >>> 0,
      "crc(doc[16:])": zlib.crc32(raw.subarray(16)) >>> 0,
      "crc(doc[20:])": zlib.crc32(raw.subarray(20)) >>> 0,
      "fnv(doc[16:])": fnv1a(raw.subarray(16)),
      "fnv(doc[20:])": fnv1a(raw.subarray(20)),
      "fnv(pool+body)": fnv1a(poolBytes),
      "sum(doc[16:])": sum32(raw.subarray(16)),
    };
    const hit = Object.entries(tests).filter(([, v]) => v === stored);
    console.log(`track ${track.MainId} ${which} kind=${track.TrackKind}: stored=0x${stored.toString(16)} -> matches: ${hit.map(([k]) => k).join(", ") || "none"}`);

    // record pattern scan over body
    const body = Buffer.from(doc.body);
    const nwords = Math.floor(body.length / 4);
    const word = (i) => body.readUInt32LE(i * 4);
    const pool = doc.pool;
    const TYPE_INDICES = new Set(pool.slice(0, 22).map((_, i) => i));

    // Locate: [nameIdx][typeIdx][values...] where name is a known property
    const interesting = new Map();
    pool.forEach((name, i) => {
      if (!TYPE_INDICES.has(i)) interesting.set(i, name);
    });

    for (let w = 0; w + 2 <= nwords; w += 1) {
      const a = word(w);
      const b = word(w + 1);
      const propName = interesting.get(a);
      if (!propName) continue;
      if (!TYPE_INDICES.has(b)) continue;
      const typeName = pool[b];
      const context = [];
      for (let k = Math.max(0, w - 2); k < w; k += 1) {
        const v = word(k);
        context.push(`w${k}=${v}${v < pool.length ? `("${pool[v].slice(0, 24)}")` : ""}`);
      }
      let detail = "";
      if (typeName === "Double" && w + 4 <= nwords) {
        const buf = Buffer.alloc(8);
        buf.writeUInt32LE(word(w + 2), 0);
        buf.writeUInt32LE(word(w + 3), 4);
        detail = ` value=${buf.readDoubleLE(0)}`;
      } else if (typeName.endsWith("[]") && w + 2 <= nwords) {
        const count = word(w + 2);
        if (count <= 4096) detail = ` count=${count}`;
      } else if (typeName === "String" && word(w + 2) < pool.length) {
        detail = ` value="${pool[word(w + 2)]}"`;
      }
      console.log(`  w${w} [${propName} : ${typeName}]${detail}   ← ${context.join(" ")}`);
    }
    console.log("");
  }
}
await db.close();
