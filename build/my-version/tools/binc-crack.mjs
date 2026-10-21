// Adaptive cracker for the "cmt binc" property-document body.
// Tries a grammar recursively, prints the decoded tree, and reports the
// first position where the stream stops making sense.
//
// Grammar under test (G1):
//   stream := value* EOF
//   value  := named | anonymous
//   named  := count u32 | name u32 | (value* count)      // container
//   named  := count u32 | name u32 | leaf                // count==1 leaf
//   ...
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

const [track] = db.prepare("SELECT MainId, TrackKind, TrackActionMixer FROM Track LIMIT 2 OFFSET 1").all();
const id = Buffer.from(track.TrackActionMixer).toString("ascii");
const blob = externalById.get(id);
const doc = readActionBlob(blob);
const pool = doc.pool;
const body = Buffer.from(doc.body);

console.log(`track ${track.MainId} kind=${track.TrackKind} pool=${pool.length} body=${body.length}`);
console.log("pool:", pool.map((p, i) => `${i}:${JSON.stringify(p)}`).join(" "));

// Word cursor
const words = [];
for (let i = 0; i + 4 <= body.length; i += 4) words.push(body.readUInt32LE(i));
const trailing = body.length % 4;
console.log(`words=${words.length} trailing=${trailing} lastBytes=${body.subarray(body.length - trailing).toString("hex")}`);

const TYPE_NAMES = new Set(pool.slice(0, 22));

// G1 grammar attempt. Every record begins with [count][name]; a container
// count is the number of child values, a leaf count is 1 and is followed by
// the value with an optional explicit type word.
let pos = 0;
function fail(msg) {
  throw new Error(`@w${pos}: ${msg}`);
}
const u32 = () => {
  if (pos >= words.length) fail("EOF");
  return words[pos++];
};

function leafPayload(typeIdx) {
  const typeName = pool[typeIdx];
  switch (typeName) {
    case "Byte": case "UInt16": case "Int16": case "UInt32": case "Int32": case "SByte": {
      const v = u32();
      return { type: typeName, value: v };
    }
    case "Single": {
      // f32 packed
      const raw = body.readUInt32LE(pos * 4); pos += 1;
      const v = Buffer.from(raw.toString(16).padStart(8, "0"), "hex").readFloatLE(0);
      return { type: typeName, value: v };
    }
    case "Double": {
      // 2 words, then possibly an aux pair — handled by caller via lookahead loop
      const lo = u32(); const hi = u32();
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(lo, 0); buf.writeUInt32LE(hi, 4);
      return { type: typeName, value: buf.readDoubleLE(0) };
    }
    case "String": {
      const idx = u32();
      return { type: typeName, value: pool[idx] ?? `<pool ${idx}>` };
    }
    case "String[]": case "Int32[]": case "Single[]": case "Byte[]"?: undefined: {
      const count = u32();
      const values = [];
      for (let i = 0; i < count; i += 1) values.push(u32());
      return { type: typeName, values };
    }
    default:
      fail(`unknown leaf type ${typeIdx} (${typeName})`);
  }
}

// --- G1 walk: [count][name] pairs, count>1 => (count) children that are
// themselves values or leaves; count==1 => value wherever it appears
const tree = [];
function walk() {
  const count = u32();
  const name = u32();
  if (count === 0) return { name: pool[name] ?? `<${name}>`, empty: true };
  if (TYPE_NAMES.has(pool[name]) && !TYPE_NAMES.has(pool[count])) {
    // [value?][typeIdx] ... leaf with explicit type named by pool[name]
    return null; // not this branch
  }
  const children = [];
  void children;
  return null;
}
void walk;

// G2 attempt: pairs [a][b]; each pair is (count,name). If count==0: end marker
// block. If b is type index: leaf, value follows per type. Else: container
// with (count) records following.
const out = [];
function g2() {
  while (pos < words.length) {
    const a = words[pos];
    const b = words[pos + 1];
    if (a === 0 && b === 0) { pos += 2; out.push(["terminator @w" + pos]); continue; }
    if (TYPE_NAMES.has(pool[b])) {
      // leaf: [type][value...]
      pos += 2;
      out.push([`leaf`, pool[b]]);
    } else {
      out.push([`pair`, a, b]);
    }
    pos += 2;
  }
}
void g2;

// Print word stream with pair framing for manual read
for (let i = 0; i < words.length; i += 1) {
  const v = words[i];
  const p = v < pool.length ? ` "${pool[v]}"` : "";
  process.stdout.write(`w${i}=${v}${p}${i % 4 === 3 ? "\n" : "  "}`);
}
console.log("");
await db.close();
