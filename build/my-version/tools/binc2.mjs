// The mixer document decoder / encoder experiment.
//
// Rules under test (G6, from the Animation2 measurements):
//   leaf         := [name u32][type u32][value: natural size][aux: 8 bytes]
//                   String/Double/Byte values were measured with aux (0,0)
//   structure    := [name u32][type=0][?][childCount][children]
//                   TimeInfo measured [44][0][0][1] then child Rate
//   top          := unknown leading pair [0][1]
//   checksum     := crc32 of doc bytes from offset 16
//
// The decoder prints a tree with per-record byte spans; on divergence it
// reports the exact word sequence around the break so the rule can be fixed.
// The encoder must reproduce the original bytes.
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

const TYPE_SIZE = { Byte: 1, SByte: 1, UInt16: 2, Int16: 2, UInt32: 4, Int32: 4, Single: 4, Double: 8, String: 4 };
const ARRAY_TYPES = new Set(["Single[]", "Byte[]", "Int32[]", "String[]", "Float2[]", "Float3[]", "Double[]", "Double2[]", "Double3[]", "Quat[]", "Matrix44[]"]);

class SeekableBody {
  constructor(bytes, pool) {
    this.bytes = bytes;
    this.pool = pool;
    this.pos = 0;
  }
  u32() {
    if (this.pos + 4 > this.bytes.length) throw new Error("EOF u32");
    const v = this.bytes.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  peekU32(off = 0) {
    return this.pos + off + 4 <= this.bytes.length ? this.bytes.readUInt32LE(this.pos + off) : null;
  }
  name(idx) {
    return this.pool[idx] ?? `<?${idx}>`;
  }
}

function isType(doc, idx) {
  return idx !== null && idx <= 21;
}
function isName(doc, idx) {
  return idx !== null && idx > 21 && idx < doc.pool.length;
}

/**
 * G6 parser, rule-ordered with backtracking.
 * Returns { node, end } or null.
 */
function parseRecord(cur, depth) {
  const start = cur.pos;
  const first = cur.peekU32();
  if (first === null) return null;

  // Candidate A: leaf [name][type][value][aux 8]
  if (isName(cur, first) && isType(cur, cur.peekU32(4))) {
    const name = cur.u32();
    const type = cur.u32();
    const typeName = cur.name(type);
    if (typeName === "null") {
      // [name][null] could be a struct; try struct: name [0] [0] [count] children
      const a = cur.peekU32();
      const b = cur.peekU32(4);
      const count = cur.peekU32(8);
      if (a === 0 && b === 0 && count !== null && count <= 64) {
        cur.pos += 8;
        const children = [];
        for (let i = 0; i < count; i += 1) {
          const child = parseRecord(cur, depth + 1);
          if (!child) return undo(depth, start, `child ${i} of ${cur.name(name)} bad`);
          children.push(child.node);
        }
        return { node: { kind: "struct", name: cur.name(name), children }, end: cur.pos };
      }
      return undo(depth, start, `null-typed ${cur.name(name)} not a struct`);
    }
    let value;
    if (typeName === "String") {
      value = cur.name(cur.u32());
    } else if (typeName === "Double") {
      const lo = cur.u32();
      const hi = cur.u32();
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(lo >>> 0, 0); buf.writeUInt32LE(hi >>> 0, 4);
      value = buf.readDoubleLE(0);
    } else if (typeName === "Byte" || typeName === "SByte") {
      value = cur.bytes[cur.pos]; cur.pos += 1;
    } else if (typeName === "UInt16" || typeName === "Int16") {
      value = cur.bytes.readUInt16LE(cur.pos); cur.pos += 2;
    } else if (typeName === "UInt32" || typeName === "Int32") {
      value = cur.u32();
    } else if (typeName === "Single") {
      value = cur.bytes.readFloatLE(cur.pos); cur.pos += 4;
    } else if (ARRAY_TYPES.has(typeName)) {
      const count = cur.u32();
      const values = [];
      for (let i = 0; i < count; i += 1) {
        const element = typeName === "String[]" ? cur.name(cur.u32())
          : typeName === "Int32[]"? cur.u32()
          : typeName === "Single[]"? (cur.bytes.readFloatLE(cur.pos), cur.pos += 4)
          : typeName === "Double[]"? (() => { const lo = cur.u32(); const hi = cur.u32(); return [lo, hi]; })()
          : typeName === "Byte[]" ? cur.bytes[cur.pos++]
          : null;
        if (element === null) return undo(depth, start, `unhandled array ${typeName}`);
        values.push(element);
      }
      value = values;
    } else {
      return undo(depth, start, `unhandled type ${typeName}`);
    }
    const aux = [cur.u32(), cur.u32()];
    return { node: { kind: "leaf", name: cur.name(name), type: typeName, value, aux }, end: cur.pos };
  }

  // Candidate B: counted-children record [count][name] children …
  if (isName(cur, cur.peekU32(4)) && first < 256) {
    const count = cur.u32();
    const name = cur.u32();
    const children = [];
    for (let i = 0; i < count; i += 1) {
      const child = parseRecord(cur, depth + 1);
      if (!child) return undo(depth, start, `child ${i} of ${cur.name(name)} bad`);
      children.push(child.node);
    }
    return { node: { kind: "group", name: cur.name(name), count, children }, end: cur.pos };
  }

  // Candidate C: anonymous leaf [type][value][aux 8]
  if (isType(cur, first) && first > 0) {
    const type = cur.u32();
    const typeName = cur.name(type);
    let value;
    if (typeName === "String") value = cur.name(cur.u32());
    else return undo(depth, start, `anon type ${typeName} unhandled`);
    const aux = [cur.u32(), cur.u32()];
    return { node: { kind: "anon", type: typeName, value, aux }, end: cur.pos };
  }

  return undo(depth, start, `no rule at @${cur.pos}`);
}

function undo(depth, start, why) {
  const e = new Error(why);
  e.depth = depth;
  e.start = start;
  throw e;
}

function dump(node, indent = "") {
  if (node.kind === "leaf") {
    return `${indent}leaf ${node.name} : ${node.type} = ${JSON.stringify(node.value)} aux=[${node.aux}]`;
  }
  if (node.kind === "anon") {
    return `${indent}anon ${node.type} = ${JSON.stringify(node.value)} aux=[${node.aux}]`;
  }
  const head = `${indent}${node.kind} ${node.name}${node.count !== undefined ? ` (${node.count})` : ""}`;
  return [head, ...node.children.map((c) => dump(c, indent + "  "))].join("\n");
}

async function decode(blobPath) {
  const data = fs.readFileSync(blobPath);
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
  for (const track of tracks) {
    for (const col of ["TrackActionMixer", "TrackActionMixer2"]) {
      const id = Buffer.from(track[col]).toString("ascii");
      const blob = externalById.get(id);
      if (!blob) continue;
      const doc = readActionBlob(blob);
      if (!doc) continue;
      console.log(`\n### track ${track.MainId} ${col} kind=${track.TrackKind} version=${doc.version}`);
      const body = Buffer.from(doc.body);
      const cur = new SeekableBody(body, doc.pool);
      try {
        const root = parseRecord(cur, 0);
        if (cur.pos !== body.length) {
          console.log(`  INCOMPLETE: consumed ${cur.pos}/${body.length}; leftover words: ${body.subarray(Math.max(0, cur.pos)).toString("hex")}`);
        } else {
          console.log(dump(root.node));
        }
      } catch (e) {
        console.log(`  FAILED @${e.start} depth=${e.depth}: ${e.message}`);
        const at = Math.max(0, e.start - 24);
        console.log(`  context: ${body.subarray(at, Math.min(body.length, e.start + 40)).toString("hex")}`);
      }
    }
  }
  await db.close();
}

for (const file of process.argv.slice(2)) {
  try {
    await decode(file);
  } catch (e) {
    console.log(`file: ${e.stack}`);
  }
}
