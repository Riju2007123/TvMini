// Structural cracker: tests grammar hypotheses against a real mixer body.
// Prints, for each hypothesis, how far it walks before breaking.
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

const theTrack = db.prepare("SELECT MainId, TrackKind, TrackActionMixer FROM Track ORDER BY MainId LIMIT 1").get();
const mixerId = Buffer.from(theTrack.TrackActionMixer).toString("ascii");
const doc = readActionBlob(externalById.get(mixerId));
const pool = doc.pool;
const body = Buffer.from(doc.body);
console.log(`kind=${theTrack.TrackKind} pool=${pool.length} body=${body.length}`);
console.log("types:", pool.slice(0, 22).map((p, i) => `${i}:${p}`).join(" "));

const TYPES = new Set(pool.slice(0, 22));

// Cursor in BYTES (names and counts are u32; leaf values natural size).
function makeCursor() {
  return { p: 0 };
}
function peekU32(cur, off = 0) {
  return cur.p + off + 4 <= body.length ? body.readUInt32LE(cur.p + off) : null;
}
function readU32(cur) {
  if (cur.p + 4 > body.length) throw new Error("EOF u32");
  const v = body.readUInt32LE(cur.p);
  cur.p += 4;
  return v;
}

const NATURAL = {
  Byte: 1, SByte: 1, UInt16: 2, Int16: 2, UInt32: 4, Int32: 4,
  Single: 4, Double: 8, String: 4,
};

// Hypothesis H1:   leaf := [typeIdx u32][value natural][aux 8]
//                  property := [nameIdx u32][rest]
//                  container := [nameIdx u32][childCount u32] children*
//                  terminator := [0][0]
function tryH1(label) {
  const cur = makeCursor();
  const stack = [];
  try {
    for (;;) {
      if (cur.p >= body.length) break;
      const a = peekU32(cur);
      const b = peekU32(cur, 4);
      const c = peekU32(cur, 8);
      if (a === 0 && b === 0) { cur.p += 8; continue; }
      if (TYPES.has(pool[a])) {
        // typed leaf:  [type][natural value][aux 8B]
        const typeName = pool[a];
        let size = NATURAL[typeName];
        if (typeName === "String") readU32(cur);
        else cur.p += 4, cur.p += size - 4;
        cur.p += 8;
        continue;
      }
      if (b !== null && b < pool.length && !TYPES.has(pool[b]) && c !== null) {
        // property: [name][count]...
        readU32(cur);
        const count = readU32(cur);
        if (count === 0) continue; // empty property
        // children: count nested items...
        stack.push({ name: pool[a], count, consumed: 0 });
        for (let i = 0; i < 100000; i += 1) {
          if (stack.length === 0) break;
          const top = stack[stack.length - 1];
          if (top.consumed >= top.count) { stack.pop(); continue; }
          const x = peepOrBreak(cur);
          if (x === "break") break;
          void x;
        }
        continue;
      }
      throw new Error(`stuck: a=${a} (${pool[a] ?? "?"}) b=${b}`);
    }
    console.log(`${label}: consumed=${cur.p}/${body.length} leftover=${body.length - cur.p}`);
    return cur;
  } catch (e) {
    console.log(`${label}: FAILED ${e.message} at byte ${cur.p}`);
    return null;
  }
}

function peepOrBreak(cur) {
  return "break";
}

tryH1("H1");
await db.close();
