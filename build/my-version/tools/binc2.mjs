// The mixer document codec ("cmt binc") — translucent round-trip edition.
//
// Proven grammar (Animation2.clip, docs/clip-format-study.md):
//   doc = [16B hdr][pool][u32 typeCount][body]
//   body = header pair (0100 = [0][1]; 0110 = [20][32][22][0], opaque)
//        + records ... (+ 0..3 trailing bytes)
//   record =
//     0110 prefix:  [16][X][Y]              — opaque triplet, re-emitted verbatim
//     typed leaf:   [name][type 1..13][value natural][aux 2×u32]   (all measured aux = (0,0))
//                   type 8 (Double) → 8-byte value; type 1 (Byte) → 1-byte value
//                   (Byte leaves leave the stream unaligned from then on)
//     array leaf:   [name][type 14..21][count][count×4-byte elements][aux 2×u32]
//                   (Byte[] → 1-byte elements; Quat[]/Matrix44[] larger)
//     string leaf:  [name][poolIdx]          — no type, no aux ("version", "Name", ...)
//     struct:       [name][0][maybe extra 0][count][children × count]
//                   (count position ambiguous → tried as 2 candidates)
//     pair:         [small count][name>21][count children]
//                   (candidate for the [1][23 version][24] / [2][25 VI] forms)
//
// The parser backtracks over candidates at every boundary and only accepts a
// parse that consumes the body exactly to EOF. The encoder re-emits each node's
// span verbatim, so a full parse guarantees a byte-identical re-encode; that
// property is what the splice-writer relies on (decode → patch tree → encode).
//
// Usage: node tools/binc2.mjs <file.clip> [...]
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
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

const SCALAR_SIZE = {
  Byte: 1, SByte: 1, UInt16: 2, Int16: 2,
  UInt32: 4, Int32: 4, Single: 4, Double: 8, String: 4,
};
const ELEMENT_SIZE = {
  "Single[]": 4, "Byte[]": 1, "Int32[]": 4, "String[]": 4, "Double[]": 8,
  "Float2[]": 8, "Float3[]": 12, "Double2[]": 16, "Double3[]": 24, "Quat[]": 16,
  "Matrix44[]": 64,
};
const MAX_COUNT = 1 << 20;
const MAX_DEPTH = 48;
const MAX_STEPS = 20_000_000;

let steps = 0;
let deepest = null;
class Fail extends Error {
  constructor(why) {
    super(why);
    this.fatal = false;
  }
}
class Fatal extends Error {}

function isNamed(cur, idx) { return idx !== null && idx >= 22 && idx < cur.pool.length; }
function isType(cur, idx) { return idx !== null && idx >= 1 && idx <= 21; }

function typeName(cur, idx) {
  return (idx !== null && idx >= 0 && idx < cur.pool.length) ? cur.pool[idx] : `<?${idx}>`;
}

// ---- field readers -------------------------------------------------------

function readScalar(cur, typeName) {
  const size = SCALAR_SIZE[typeName];
  if (size === 4 && typeName === "String") return { kind: "pool", idx: cur.u32() };
  if (size === 8) {
    const b = cur.raw(8);
    return { kind: "f64", value: b.readDoubleLE(0) };
  }
  if (size === 4) {
    const b = cur.raw(4);
    return { kind: typeName === "Single" ? "f32" : "int", value: typeName === "Single" ? b.readFloatLE(0) : b.readUInt32LE(0) };
  }
  if (size === 2) return { kind: "int", value: cur.raw(2).readUInt16LE(0) };
  return { kind: "int", value: cur.raw(1)[0] };
}

function readArray(cur, typeName) {
  const count = cur.u32();
  if (count > MAX_COUNT) throw new Fail(`array count ${count} implausible`);
  const esize = ELEMENT_SIZE[typeName];
  if (cur.pos + count * esize > cur.bytes.length) throw new Fail("array runs past EOF");
  const values = [];
  for (let i = 0; i < count; i += 1) {
    if (typeName === "String[]") values.push({ idx: cur.u32() });
    else if (typeName === "Int32[]" || typeName === "UInt32[]") values.push(cur.u32());
    else if (typeName === "Single[]") values.push(cur.raw(4).readFloatLE(0));
    else if (typeName === "Double[]") values.push(cur.raw(8).readDoubleLE(0));
    else values.push([...cur.raw(esize)]);
  }
  return { kind: "array", type: typeName, values };
}

// ---- candidates ----------------------------------------------------------
// The parse is a complete search: genNode yields every viable record shape at
// the current boundary (in priority order), genAll composes record sequences
// and only completes an exact-EOF split. Wrong-but-self-consistent forms are
// naturally abandoned when the rest of the stream cannot be consumed.
//
//   1. 0110 triplet  [16][X][Y]                     (opaque, verbatim)
//   2. typed leaf    [name>21][type 1..21][value natural][aux 2×u32]
//   3. string leaf   [name>21][poolIdx]
//   4. opaque lead   [u32<22 …][named record]       (small words before a named
//                    record; re-emitted verbatim)
//   5. struct        [name>21][0][extra 0?][count][children × count]
//   6. counted item  [count≤63][name>21][count × u32][optional (0,0) aux]

function* genNode(cur, depth, mode) {
  if (steps > MAX_STEPS) throw new Fatal("step budget exhausted");
  const start = cur.pos;
  const first = cur.peek();
  const second = cur.peek(4);

  const attempts = [];
  const add = (fn) => attempts.push(fn);

  // 1 — 0110 triplet prefix [16][X][Y] then a record.
  if (mode === "0110" && first === 16) {
    add(() => {
      cur.u32(); cur.u32(); cur.u32();
      const child = parseFirstSync(cur, depth, mode);
      const span = cur.bytes.subarray(start, start + 12);
      child.prefix = child.prefix ? Buffer.concat([span, child.prefix]) : span;
      child.begin = start;
      return child;
    });
  }

  // 2 — typed leaf / array leaf: [name][type][value by type][aux 2×u32]
  if (isNamed(cur, first) && isType(cur, second)) {
    add(() => {
      const nameIdx = cur.u32();
      const name = typeName(cur, nameIdx);
      const typeId = cur.u32();
      const tName = typeName(cur, typeId);
      const value = ELEMENT_SIZE[tName] ? readArray(cur, tName) : readScalar(cur, tName);
      const aux = [cur.u32(), cur.u32()];
      if (aux[0] !== 0 || aux[1] !== 0) throw new Fail(`aux not (0,0) at "${name}"`);
      return { kind: "leaf", name, nameIdx, typeId, type: tName, value, aux, begin: start, end: cur.pos };
    });
  }

  // 3 — bare string leaf: [name][poolIdx]
  if (isNamed(cur, first) && isNamed(cur, second)) {
    add(() => {
      const nameIdx = cur.u32();
      const name = typeName(cur, nameIdx);
      const idx = cur.u32();
      return { kind: "sleaf", name, nameIdx, valueIdx: idx, begin: start, end: cur.pos };
    });
  }

  // 4 — opaque lead-in: one or more small words (not pool names, e.g. 1, 2, 5)
  // before a named record (or a triplet). The lead is attached verbatim.
  if (first !== null && first >= 0 && first < 22 && !(mode === "0110" && first === 16)) {
    const secondFollows = second !== null && (isNamed(cur, second) || (mode === "0110" && second === 16));
    if (secondFollows) {
      add(() => {
        cur.u32();
        const child = parseFirstSync(cur, depth, mode);
        const span = cur.bytes.subarray(start, start + 4);
        child.prefix = child.prefix ? Buffer.concat([span, child.prefix]) : span;
        child.begin = start;
        return child;
      });
    }
  }

  // 5 — struct: [name][0][extra 0?][count][children × count]
  if (isNamed(cur, first) && second === 0) {
    for (const extra of [1, 0]) {
      add(() => {
        const nameIdx = cur.u32();
        const name = typeName(cur, nameIdx);
        cur.u32(); // type 0
        if (extra) {
          const pad = cur.u32();
          if (pad !== 0) throw new Fail("struct extra pad not zero");
        }
        const count = cur.u32();
        if (count > 64) throw new Fail(`struct count ${count} implausible`);
        const it = genSeq(cur, depth + 1, count, mode);
        const children = it.next().value;
        if (!children) throw new Fail(`struct "${name}" children exhausted`);
        return { kind: "struct", name, nameIdx, extra, children, begin: start, end: cur.pos };
      });
    }
  }

  // 6 — counted item: [count≤63][name>21][count × u32][optional (0,0) aux].
  // In 0110 docs a triplet may be inserted between the count and the name
  // (e.g. 0100 [2][Param][6][3] ↔ 0110 [2][triplet][Param][6][3]); it is
  // captured verbatim as the item's prefix.
  if (first !== null && first >= 0 && first < 64 && first !== 16 &&
      (second !== null && (isNamed(cur, second) || (mode === "0110" && second === 16)))) {
    add(() => {
      const count = cur.u32();
      if (count > 63) throw new Fail(`item count ${count} implausible`);
      let prefix = null;
      if (mode === "0110" && cur.bytes.length - cur.pos >= 12 && cur.peek() === 16) {
        prefix = cur.raw(12); // advances the cursor
      }
      const nameIdx = cur.u32();
      const values = [];
      for (let i = 0; i < count; i += 1) values.push(cur.u32());
      let aux = null;
      if (cur.peek() === 0 && cur.peek(4) === 0) {
        cur.u32(); cur.u32();
        aux = [0, 0];
      }
      return { kind: "pairitem", name: typeName(cur, nameIdx), count, values, aux, nameIdx, prefix, begin: start, end: cur.pos };
    });
  }

  for (const attempt of attempts) {
    steps += 1;
    try {
      const node = attempt();
      if (process.env.BINC2_TRACE) {
        const brief = node.kind === "leaf" ? `leaf ${node.name}:${node.type}`
          : node.kind === "sleaf" ? `sleaf ${node.name}="${node.valueIdx}"`
          : node.kind === "pairitem" ? `item ${node.name}[${node.values.length}]`
          : `struct ${node.name}(${node.children?.length})`;
        console.error(`trace @${start} ${brief} -> ${node.end}${node.prefix ? " +prefix" : ""}`);
      }
      try {
        yield node;
      } finally {
        cur.pos = start; // restore for the next candidate
      }
    } catch (e) {
      cur.pos = start;
      if (e instanceof Fatal) throw e;
    }
  }
  if (!deepest || start > deepest.pos) deepest = { pos: start, why: `first=${first}, 2nd=${second}` };
}

// Yields every sequence of exactly `n` consecutive records.
function* genSeq(cur, depth, n, mode) {
  if (n === 0) { yield []; return; }
  const start = cur.pos;
  for (const first of genNode(cur, depth, mode)) {
    cur.pos = first.end;
    for (const rest of genSeq(cur, depth, n - 1, mode)) {
      yield [first, ...rest];
      cur.pos = first.end; // restore: inner generator left its own restore point
    }
    cur.pos = start;
  }
}

// Yields every record sequence that consumes the body to within <4 bytes.
function* genAll(cur, depth, mode) {
  const remaining = cur.bytes.length - cur.pos;
  if (remaining < 4) {
    yield { nodes: [], tail: cur.bytes.subarray(cur.pos) };
    return;
  }
  const start = cur.pos;
  for (const first of genNode(cur, depth, mode)) {
    cur.pos = first.end;
    for (const rest of genAll(cur, depth, mode)) {
      yield { nodes: [first, ...rest.nodes], tail: rest.tail };
      cur.pos = first.end;
    }
    cur.pos = start;
  }
}

// One-shot deterministic parse used inside triplet/lead prefixes (there the
// ambiguity does not change what the following record is).
function parseFirstSync(cur, depth, mode) {
  const save = cur.pos;
  for (const node of genNode(cur, depth, mode)) {
    cur.pos = node.end;
    // Try to continue the rest of the stream elsewhere; prefixes never stand
    // alone, so the caller of genNode will validate the full remainder. Just
    // return the first candidate.
    return node;
  }
  cur.pos = save;
  deepest = deepest || { pos: save, why: "no candidate for prefix target" };
  throw new Fail("no candidate after prefix");
}

function parseBody(body, pool, mode) {
  steps = 0;
  deepest = null;
  for (const headWords of mode === "0110" ? [4, 5, 0] : [2, 1, 0]) {
    if (headWords * 4 > body.length) continue;
    const cur = new Cursor(body, pool);
    const headRaw = cur.raw(headWords * 4);
    try {
      for (const seq of genAll(cur, 0, mode)) {
        return { headWords, headRaw, nodes: seq.nodes, tail: seq.tail };
      }
    } catch (e) {
      if (!(e instanceof Fatal)) throw e;
      break;
    }
  }
  return { failed: true, bomb: deepest };
}

class Cursor {
  constructor(bytes, pool) {
    this.bytes = bytes;
    this.pool = pool;
    this.pos = 0;
  }
  u32() {
    if (this.pos + 4 > this.bytes.length) throw new Fail("EOF u32");
    const v = this.bytes.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  peek(off = 0) {
    return this.pos + off + 4 <= this.bytes.length ? this.bytes.readUInt32LE(this.pos + off) : null;
  }
  raw(n) {
    if (this.pos + n > this.bytes.length) throw new Fail("EOF raw");
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}

// ---- encoder (from the tree) --------------------------------------------

function writeU32(out, v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  out.push(b);
}

function writeValue(out, value, type) {
  if (value.kind === "pool") { writeU32(out, value.idx); return; }
  if (value.kind === "f64") {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value.value, 0);
    out.push(b);
    return;
  }
  if (value.kind === "f32") {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value.value, 0);
    out.push(b);
    return;
  }
  if (value.kind === "int") {
    const size = SCALAR_SIZE[type];
    const b = Buffer.alloc(size);
    if (size === 1) b[0] = value.value & 0xff;
    else if (size === 2) b.writeUInt16LE(value.value & 0xffff, 0);
    else b.writeUInt32LE(value.value >>> 0, 0);
    out.push(b);
    return;
  }
  if (value.kind === "array") {
    writeU32(out, value.values.length);
    for (const v of value.values) {
      if (value.type === "String[]") writeU32(out, v.idx);
      else if (value.type === "Int32[]" || value.type === "UInt32[]") writeU32(out, v);
      else if (value.type === "Single[]") {
        const b = Buffer.alloc(4);
        b.writeFloatLE(v, 0);
        out.push(b);
      } else if (value.type === "Double[]") {
        const b = Buffer.alloc(8);
        b.writeDoubleLE(v, 0);
        out.push(b);
      } else out.push(Buffer.from(v));
    }
    return;
  }
  throw new Fatal(`cannot write value kind ${value.kind}`);
}

function encodeNode(node, out) {
  // pairitems carry their prefix after the count word (0110 inserts the
  // triplet between count and name), so the generic prefix emit is skipped.
  if (node.prefix && node.kind !== "pairitem") out.push(Buffer.from(node.prefix));
  switch (node.kind) {
    case "struct": {
      if (node.countWord !== undefined) {
        writeU32(out, node.countWord);
        writeU32(out, node.nameIdx);
        for (const c of node.children) encodeNode(c, out);
      } else {
        writeU32(out, node.nameIdx);
        writeU32(out, 0);
        if (node.extra) writeU32(out, 0);
        writeU32(out, node.children.length);
        for (const c of node.children) encodeNode(c, out);
      }
      break;
    }
    case "sleaf":
      writeU32(out, node.nameIdx);
      writeU32(out, node.valueIdx);
      break;
    case "pairitem":
      writeU32(out, node.count);
      if (node.prefix) out.push(Buffer.from(node.prefix)); // 0110: triplet after the count
      writeU32(out, node.nameIdx);
      for (const v of node.values) writeU32(out, v);
      if (node.aux) { writeU32(out, node.aux[0]); writeU32(out, node.aux[1]); }
      break;
    case "leaf":
      writeU32(out, node.nameIdx);
      writeU32(out, node.typeId);
      writeValue(out, node.value, node.type);
      writeU32(out, node.aux[0]);
      writeU32(out, node.aux[1]);
      break;
    default:
      throw new Fatal(`cannot encode node kind ${node.kind}`);
  }
}

function encodeTree(result) {
  const out = [];
  if (result.headRaw) out.push(Buffer.from(result.headRaw));
  for (const n of result.nodes) encodeNode(n, out);
  if (result.tail && result.tail.length) out.push(Buffer.from(result.tail));
  return Buffer.concat(out);
}

// ---- reporting -----------------------------------------------------------

function printTree(node, pool, indent, out) {
  let text = "";
  if (node.prefix) out.push(indent + `<triplet ${[...node.prefix].join(",")}>`);
  switch (node.kind) {
    case "leaf": {
      text = `leaf ${node.name} : ${node.type}`;
      const v = node.value;
      if (v.kind === "pool") text += ` = "${pool[v.idx]}"`;
      else if (v.kind === "array") {
        text += ` [${v.values.length}]`;
        if (v.type === "String[]" && v.values.length) {
          text += ` = ${v.values.map((x) => `"${pool[x.idx]}"`).join(",").slice(0, 90)}`;
        } else if (v.type === "Single[]") {
          text += ` = ${v.values.map((x) => +x.toFixed(3)).join(",").slice(0, 90)}`;
        } else if (v.type === "Int32[]") {
          text += ` = ${v.values.join(",").slice(0, 90)}`;
        }
      } else if (v.value !== null && v.value !== undefined) text += ` = ${v.value}`;
      if (node.aux[0] || node.aux[1]) text += ` aux=(${node.aux[0]},${node.aux[1]})`;
      break;
    }
    case "sleaf":
      text = `sleaf ${node.name} = "${pool[node.valueIdx]}"`;
      break;
    case "pairitem":
      text = `item ${node.name} [${node.values.map((v) => pool[v] ?? v).join(",")}]${node.aux ? " aux=(0,0)" : ""}`;
      break;
    case "struct":
      text = `struct ${node.name}` + (node.countWord !== undefined ? ` (pair ${node.countWord})` : "") + ` (${node.children.length}${node.extra ? " +extra0" : ""})`;
      break;
    default:
      text = `?${node.kind}`;
  }
  if (node.begin !== undefined) text += ` [@${node.begin}..${node.end}]`;
  out.push(indent + text);
  if (node.children) for (const c of node.children) printTree(c, pool, indent + "  ", out);
}

async function decodeFile(path) {
  const data = fs.readFileSync(path);
  const raw = extractDatabase(data);
  if (!raw) { console.log(`${path}: no database`); return; }
  const db = await openDatabase(new Buffer(raw));
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
  try {
    const tracks = db.prepare("SELECT MainId, TrackKind, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all();
    let pass = 0, fail = 0;
    for (const track of tracks) {
      for (const col of ["TrackActionMixer", "TrackActionMixer2"]) {
        const id = Buffer.from(track[col]).toString("ascii");
        const blob = externalById.get(id);
        if (!blob) continue;
        let doc;
        try { doc = readActionBlob(blob); } catch { continue; }
        if (!doc) continue;
        const label = `track ${track.MainId} ${col === "TrackActionMixer" ? "mixer" : "mixer2"} kind=${track.TrackKind}`;
        const body = Buffer.from(doc.body);
        const result = parseBody(body, doc.pool, doc.version);
        if (result && !result.failed) {
          let re;
          try { re = encodeTree(result); } catch (e) { re = null; void e; }
          const identical = re !== null && Buffer.compare(re, body) === 0;
          if (identical) pass += 1; else fail += 1;
          console.log(`  ${identical ? "OK" : "TREE-BROKEN"} ${label} doc=${doc.version} headWords=${result.headWords}${identical ? " roundtrip=IDENTICAL" : " re-encode differs (re=" + (re && re.length) + " vs " + body.length + ")"}`);
          if (!identical && re) {
            const n = Math.min(re.length, body.length);
            let d = 0;
            while (d < n && re[d] === body[d]) d += 1;
            console.log(`    first diff @${d}: orig ${body.subarray(Math.max(0, d - 12), d + 24).toString("hex")} vs re ${re.subarray(Math.max(0, d - 12), Math.min(re.length, d + 24)).toString("hex")}`);
            const brief = (node) => {
              let s = `${node.kind}@${node.begin}..${node.end}`;
              if (node.prefix) s += ` prefix=[${[...node.prefix].map((w) => w).join(",")}]`;
              if (node.kind === "pairitem") s += ` count=${node.count} nameIdx=${node.nameIdx} values=[${node.values}]`;
              return s;
            };
            for (const node of result.nodes) console.log(`    top: ${brief(node)}`);
          }
        } else {
          fail += 1;
          const bomb = result.bomb ?? { pos: -1, why: "?" };
          console.log(`  FAILED ${label} doc=${doc.version} bomb=@${bomb.pos} ${bomb.why}`);
          if (bomb.pos >= 0 && bomb.pos < body.length) {
            const lo = Math.max(0, bomb.pos - 32);
            console.log(`    near: ${body.subarray(lo, Math.min(body.length, bomb.pos + 24)).toString("hex").replace(/(..)/g, "$1 ").trim()}`);
            // annotated word walk backwards from the bomb
            const pool = doc.pool;
            const lines = [];
            for (let p = Math.max(bomb.pos - 128, 0); p < Math.min(body.length, bomb.pos + 16); p += 4) {
              const v = body.readUInt32LE(p);
              let note = "";
              if (v < pool.length) note = `<${v}:${pool[v]}>`;
              lines.push(`@${p}=0x${v.toString(16)}${note}`);
            }
            console.log(`    words: ${lines.join(" ")}`);
          }
        }
      }
    }
    console.log(`${path.replace(/^.*[\\/]/, "")}: round-trip pass=${pass} fail=${fail}`);
  } finally {
    await db.close();
  }
}

async function dumpOnly(path) {
  const data = fs.readFileSync(path);
  const raw = extractDatabase(data);
  if (!raw) { console.log(`${path}: no database`); return; }
  const db = await openDatabase(new Buffer(raw));
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
  try {
    const tracks = db.prepare("SELECT MainId, TrackKind, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all();
    for (const track of tracks) {
      for (const col of ["TrackActionMixer", "TrackActionMixer2"]) {
        const id = Buffer.from(track[col]).toString("ascii");
        const blob = externalById.get(id);
        if (!blob) continue;
        let doc;
        try { doc = readActionBlob(blob); } catch { continue; }
        if (!doc) continue;
        const label = `track ${track.MainId} ${col === "TrackActionMixer" ? "mixer" : "mixer2"} kind=${track.TrackKind}`;
        const body = Buffer.from(doc.body);
        console.log(`\n### ${path.replace(/^.*[\\/]/, "")} ${label} doc=${doc.version} pool=${doc.pool.length} body=${body.length}`);
        console.log(`pool: ${doc.pool.map((s, i) => `${i}:"${s}"`).join(" ")}`);
        const pool = doc.pool;
        const result = parseBody(body, pool, doc.version);
        if (!result || result.failed) {
          const bomb = (result && result.bomb) || { pos: -1, why: "?" };
          console.log(`  FAILED: no candidate parse consumed the body (bomb=@${bomb.pos} ${bomb.why})`);
          if (bomb.pos >= 0) {
            const lo = Math.max(0, bomb.pos - 32);
            console.log(`    near: ${body.subarray(lo, Math.min(body.length, bomb.pos + 24)).toString("hex").replace(/(..)/g, "$1 ").trim()}`);
          }
          continue;
        }
        const out = [];
        for (const n of result.nodes) printTree(n, pool, "  ", out);
        console.log(out.join("\n"));
        let re = null;
        try { re = encodeTree(result); } catch (e) { re = null; console.log(`  encode error: ${e.message}`); }
        console.log(`  headWords=${result.headWords} roundtrip=${re && Buffer.compare(re, body) === 0 ? "IDENTICAL" : "DIFFERS"}${re ? ` (re=${re.length}B vs ${body.length}B)` : ""}`);
      }
    }
  } finally {
    await db.close();
  }
}

// CLI: dump mode when a second arg == "dump", else just round-trip report.
const files = process.argv.slice(2).filter((a) => a !== "dump");
const dump = process.argv.includes("dump");
for (const file of files) {
  try {
    if (dump) dumpOnly(file);
    else await decodeFile(file);
  } catch (e) {
    console.log(`file: ${e.stack}`);
  }
}
