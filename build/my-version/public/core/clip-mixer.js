import { Buffer } from "./bytes.js";
import { deflateSync } from "./zlib.js";
import { parseActionDocument, readActionBlob, readAnimationCurves } from "./clip-animation.js";

/**
 * Writing the action document of a Clip Studio track.
 *
 * A document is `"cmt "`, a version, `"binc"`, a CRC-32, the string pool, one
 * word and then the body. Everything after the checksum is what the checksum
 * covers, so a document that is rebuilt is made valid again by computing the
 * CRC-32 of everything from offset 16. That rule was checked against every
 * mixer of `Animation3.clip` and `Animation2.clip` (14 of 14 matched).
 *
 * The body is a tree of blocks whose outer part is not decoded. The cell
 * curve inside it is decoded, and that is the only part an export has to
 * change: a curve record is self-contained, so the bytes around it stay as
 * they are and only the record is replaced. Clip Studio Paint edits a curve
 * the same way when a key is added or moved by hand.
 */

export const MIXER_MAGIC = "cmt ";

/** The width of one element of each array type a curve can hold. */
const ELEMENT_WIDTH = {
  "Byte[]": 1,
  "Single[]": 4,
  "String[]": 4,
  "Int32[]": 4,
  "UInt32[]": 4,
  "Double[]": 8,
  "Float2[]": 8,
  "Float3[]": 12,
  "Double2[]": 16,
  "Double3[]": 24,
  "Quat[]": 16,
  "Matrix44[]": 64,
};

/** The CRC-32 table, the one zlib and Clip Studio Paint both use. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 of some bytes, as a plain unsigned 32-bit number. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A growable little endian byte writer. */
export function writer() {
  const bytes = [];
  return {
    u32(value) {
      const number = value >>> 0;
      bytes.push(number & 0xff, (number >>> 8) & 0xff, (number >>> 16) & 0xff, (number >>> 24) & 0xff);
      return this;
    },
    f64(value) {
      const word = Buffer.alloc(8);
      word.writeDoubleLE(Number(value), 0);
      for (const byte of word) bytes.push(byte);
      return this;
    },
    raw(values) {
      for (const byte of values) bytes.push(byte & 0xff);
      return this;
    },
    done() {
      return Buffer.from(bytes);
    },
  };
}

/**
 * A document assembled from its parts, with the checksum computed over
 * everything from offset 16 onward.
 */
export function buildDocument({ version = "0110", codec = "binc", pool, tail = 0, body }) {
  const parts = [];
  const header = Buffer.alloc(16);
  header.write(MIXER_MAGIC, 0, "ascii");
  header.write(String(version).slice(0, 4).padEnd(4, "0"), 4, "ascii");
  header.write(String(codec).slice(0, 4).padEnd(4, "0"), 8, "ascii");
  parts.push(header);

  const count = Buffer.alloc(4);
  count.writeUInt32LE(pool.length);
  parts.push(count);
  for (const name of pool) {
    const text = Buffer.from(String(name), "utf8");
    if (text.length > 255) throw new Error("a mixer string is longer than 255 bytes");
    parts.push(Buffer.from([text.length]), text);
  }

  const tailWord = Buffer.alloc(4);
  tailWord.writeUInt32LE(tail >>> 0);
  parts.push(tailWord, body);

  const document = Buffer.concat(parts);
  document.writeUInt32LE(crc32(document.subarray(16)), 12);
  return document;
}

/** The parts of a document, with the one word between the pool and the body. */
export function documentParts(document) {
  return {
    version: document.version,
    codec: document.codec,
    pool: document.pool,
    tail: document.typeCount ?? 0,
    body: document.body,
  };
}

/** The document bytes of a parsed document, rebuilt unchanged. */
export function rebuildDocument(document) {
  return buildDocument(documentParts(document));
}

/**
 * One curve record, in the layout Clip Studio Paint writes for version 0110.
 *
 *   u32  the pool index of "FCurve"
 *   u32  0
 *   u32  how many properties follow
 *   n x  u32 property name, u32 property value
 *   u32  how many fields follow
 *   n x  u32 "Int32[]", the field's size, that size plus four,
 *        u32 the field name, u32 the field type, u32 the number of values,
 *        the values, u32 0, u32 0
 *
 * The two size words are `count * elementWidth + 24` and four more. They were
 * measured on real files: a `Double[]` of nine values says 96 and 100.
 */
export function buildCurveRecord({ pool, kind, axis = null, fields }) {
  const indexOf = (name) => {
    const index = pool.indexOf(name);
    if (index < 0) throw new Error(`the mixer has no string ${JSON.stringify(name)}`);
    return index;
  };

  const properties = [["Type", kind]];
  if (axis !== null) properties.push(["Axis", axis]);

  const out = writer();
  out.u32(indexOf("FCurve")).u32(0).u32(properties.length);
  for (const [name, value] of properties) out.u32(indexOf(name)).u32(indexOf(value));
  out.u32(fields.length);

  for (const field of fields) {
    const width = ELEMENT_WIDTH[field.type];
    if (!width) throw new Error(`a curve field cannot hold ${field.type}`);
    const count = field.values.length;
    out.u32(indexOf("Int32[]")).u32(count * width + 24).u32(count * width + 28);
    out.u32(indexOf(field.name)).u32(indexOf(field.type)).u32(count);
    for (const value of field.values) {
      if (field.type === "Double[]") out.f64(value);
      else if (field.type === "Byte[]") out.raw([value]);
      else out.u32(value);
    }
    out.u32(0).u32(0);
  }
  return out.done();
}

/** Turn the keys of a cell track into the six fields its curve carries. */
export function celCurveFields(keys, pool) {
  const indexOf = (name) => {
    const index = pool.indexOf(name);
    if (index < 0) throw new Error(`the mixer has no string ${JSON.stringify(name)}`);
    return index;
  };
  const constant = indexOf("Constant");
  return [
    { name: "Frame", type: "Double[]", values: keys.map((key) => key.time) },
    { name: "Value", type: "Double[]", values: keys.map((key) => key.value) },
    { name: "LeftSlope", type: "Double[]", values: keys.map(() => 0) },
    { name: "RightSlope", type: "Double[]", values: keys.map(() => 0) },
    { name: "Interp", type: "String[]", values: keys.map(() => constant) },
    { name: "Tag", type: "String[]", values: keys.map((key) => indexOf(key.tag)) },
  ];
}

/**
 * Add strings to a document's pool and return the new pool.
 *
 * The body refers to strings by index, so appending is safe: every existing
 * index keeps its meaning.
 */
export function withStrings(pool, names) {
  const next = [...pool];
  for (const name of names) {
    if (!next.includes(name)) next.push(name);
  }
  return next;
}

/**
 * Replace one curve record of a document, or add it when there is none.
 *
 * `body` is the part of the document after the pool, and the record is found
 * in it the same way the reader finds it. Returns the new document bytes.
 * When no record of that kind exists, the new one is appended to the body on
 * a four byte boundary; the reader scans the whole body, so it is found there
 * just the same.
 */
export function replaceCurve(document, { kind, axis = null, fields }) {
  const parts = documentParts(document);
  const record = buildCurveRecord({ pool: parts.pool, kind, axis, fields });

  const matches = readAnimationCurves(document).filter(
    (curve) => curve.kind === kind && (curve.axis ?? null) === axis,
  );
  if (matches.length > 1) {
    throw new Error(`the mixer holds ${matches.length} curves of ${kind}`);
  }

  let body;
  if (matches.length === 1) {
    const { start, end } = matches[0];
    body = Buffer.concat([parts.body.subarray(0, start), record, parts.body.subarray(end)]);
  } else {
    const pad = (4 - (parts.body.length % 4)) % 4;
    body = Buffer.concat([parts.body, Buffer.alloc(pad), record]);
  }

  return buildDocument({ ...parts, body });
}

/**
 * Patch every `End` of the document to a new time.
 *
 * A track carries two of them, the `TimeClip` and the `MotionClip`, and both
 * say where the track stops. They are plain doubles written as their name,
 * their type and the value, so they are found by that pair.
 */
export function setTrackEnd(document, ticks) {
  const parts = documentParts(document);
  const endId = parts.pool.indexOf("End");
  const doubleId = parts.pool.indexOf("Double");
  if (endId < 0 || doubleId < 0) return document;

  const body = Buffer.from(parts.body);
  let patched = 0;
  for (let at = 0; at + 16 <= body.length; at += 1) {
    if (body.readUInt32LE(at) !== endId) continue;
    if (body.readUInt32LE(at + 4) !== doubleId) continue;
    body.writeDoubleLE(Number(ticks), at + 8);
    patched += 1;
  }
  if (patched === 0) return document;
  return buildDocument({ ...parts, body });
}

/**
 * The external chunk that carries a document.
 *
 * The payload is the locator, the length of what follows, the length of the
 * compressed part and the zlib stream itself:
 *
 *   0   u64 big endian   40, the length of the locator
 *   8   "extrnlid" and 32 hex characters
 *   48  u64 big endian   four plus the compressed length
 *   56  u32 little endian  the compressed length
 *   60                   the zlib stream
 */
export function encodeMixerPayload(document, idText) {
  const id = String(idText);
  if (id.length !== 40) throw new Error("a mixer id is 40 characters long");
  const compressed = deflateSync(Buffer.from(document));
  const head = Buffer.alloc(60);
  head.writeBigUInt64BE(BigInt(40), 0);
  head.write(id, 8, "ascii");
  head.writeBigUInt64BE(BigInt(4 + compressed.length), 48);
  head.writeUInt32LE(compressed.length, 56);
  return Buffer.concat([head, compressed]);
}

/**
 * The size a `Track` row records next to a mixer: the length of the unpacked
 * document. A real row says 1336 for a document of 1336 bytes.
 */
export function mixerColumnSize(document) {
  return document.length;
}

/** The parsed document a mixer payload carries. */
export function decodeMixerPayload(payload) {
  const document = readActionBlob(payload);
  return document ?? parseActionDocument(payload);
}

/** A fresh locator for a mixer: `extrnlid` and 32 hex characters. */
export function newMixerId(random = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0").toUpperCase();
  return `extrnlid${hex}`;
}
