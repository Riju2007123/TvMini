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
    f32(value) {
      const word = Buffer.alloc(4);
      word.writeFloatLE(Number(value), 0);
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
 *
 * `meta` is false for the version 0100 flavour, whose fields carry no size
 * words: the record is the curve head and fields alone, and the three words
 * before each field are left out. Measured the same way on the 0100 mixers:
 * the fields line up directly behind the field count.
 */
export function buildCurveRecord({ pool, kind, axis = null, fields, meta = true }) {
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
    if (meta) out.u32(indexOf("Int32[]")).u32(count * width + 24).u32(count * width + 28);
    out.u32(indexOf(field.name)).u32(indexOf(field.type)).u32(count);
    for (const value of field.values) {
      if (field.type === "Double[]") out.f64(value);
      else if (field.type === "Single[]") out.f32(value);
      else if (field.type === "Byte[]") out.raw([value]);
      else out.u32(value);
    }
    out.u32(0).u32(0);
  }
  return out.done();
}

/** Turn the keys of a cell track into the six fields its curve carries. */
export function celCurveFields(keys, pool, types = {}) {
  const indexOf = (name) => {
    const index = pool.indexOf(name);
    if (index < 0) throw new Error(`the mixer has no string ${JSON.stringify(name)}`);
    return index;
  };
  // The rebuilt fields keep the array types the document carries: a version
  // 0100 document stores its times as `Single[]` where a 0110 document uses
  // `Double[]`. A curve that is being spliced passes its own field types in.
  const typeOf = (name, fallback) => (types[name] ?? fallback);
  const constant = indexOf("Constant");
  return [
    { name: "Frame", type: typeOf("Frame", "Double[]"), values: keys.map((key) => key.time) },
    { name: "Value", type: typeOf("Value", "Double[]"), values: keys.map((key) => key.value) },
    { name: "LeftSlope", type: typeOf("LeftSlope", "Double[]"), values: keys.map(() => 0) },
    { name: "RightSlope", type: typeOf("RightSlope", "Double[]"), values: keys.map(() => 0) },
    { name: "Interp", type: typeOf("Interp", "String[]"), values: keys.map(() => constant) },
    { name: "Tag", type: typeOf("Tag", "String[]"), values: keys.map((key) => indexOf(key.tag)) },
  ];
}

/**
 * How far into the second a frame sits, in ticks.
 *
 * Clip Studio keeps key times in document ticks at 60 Hz, so a frame of a
 * 24 fps document starts 2.5 ticks after the one before. `frame` is 1
 * based: the first frame of a document is tick 0.
 */
export function tickOfFrame(frame, frameRate) {
  const fps = Number(frameRate) > 0 ? Number(frameRate) : 30;
  return ((frame - 1) * 60) / fps;
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
 * Locate the curve record a document holds, whichever flavour it carries.
 *
 * The reader's own scan understands only the version 0110 flavour, whose
 * array fields carry the `Int32[]` size words. The version 0100 flavour
 * writes the same record without them, so its curves are walked here the
 * same byte by byte way, minus the three size words.
 *
 * Returns `{ start, end, fieldStart, fields, props, meta }`, where `start`
 * is the `FCurve` word, `end` is the first byte behind the record, and
 * `fields` maps a field name to `{ type, width, values }` with the values
 * as they sit in the record (pool indices for string fields). `meta` says
 * which flavour the record was found in.
 */
export function locateCurve(document, kind, axis = null) {
  const { body, pool } = document;
  const curveId = pool.indexOf("FCurve");
  const int32ArrayId = pool.indexOf("Int32[]");
  if (curveId < 0) return null;

  // The flavours to try, in the order the document's version suggests. A
  // 0100 document carries its curves without the size words; a 0110 one
  // carries them with. Both are scanned so a document written either way
  // is found.
  const attempts = [
    document.version === "0100" ? false : true,
    document.version === "0100" ? true : false,
  ];

  for (const meta of attempts) {
    if (meta && int32ArrayId < 0) continue;
    for (let start = 0; start + 12 <= body.length; start += 1) {
      if (body.readUInt32LE(start) !== curveId || body.readUInt32LE(start + 4) !== 0) continue;

      const propertyCount = body.readUInt32LE(start + 8);
      if (propertyCount < 1 || propertyCount > 8) continue;

      let at = start + 12;
      const props = new Map();
      let bad = false;
      for (let index = 0; index < propertyCount; index += 1) {
        const nameId = body.readUInt32LE(at);
        const valueId = body.readUInt32LE(at + 4);
        at += 8;
        if (nameId >= pool.length || valueId >= pool.length) { bad = true; break; }
        props.set(pool[nameId], pool[valueId]);
      }
      if (bad) continue;
      if ((props.get("Type") ?? null) !== kind) continue;
      if ((props.get("Axis") ?? null) !== axis) continue;

      const fieldCount = body.readUInt32LE(at);
      at += 4;
      if (fieldCount < 1 || fieldCount > 32) continue;

      const fieldStart = at;
      const fields = new Map();
      let broken = false;
      for (let index = 0; index < fieldCount; index += 1) {
        const head = meta ? 24 : 12;
        if (at + head > body.length) { broken = true; break; }

        let nameId;
        let typeId;
        let count;
        let metaSize;
        let metaEnd;
        if (meta) {
          const metaType = body.readUInt32LE(at);
          metaSize = body.readUInt32LE(at + 4);
          metaEnd = body.readUInt32LE(at + 8);
          if (metaType !== int32ArrayId) { broken = true; break; }
          nameId = body.readUInt32LE(at + 12);
          typeId = body.readUInt32LE(at + 16);
          count = body.readUInt32LE(at + 20);
          // The size words, the name, the type and the count: 24 bytes
          // before the values begin.
          at += 24;
        } else {
          nameId = body.readUInt32LE(at);
          typeId = body.readUInt32LE(at + 4);
          count = body.readUInt32LE(at + 8);
          at += 12;
        }
        if (nameId >= pool.length || typeId >= pool.length) { broken = true; break; }

        const name = pool[nameId];
        const type = pool[typeId];
        const width = ELEMENT_WIDTH[type];
        if (width === undefined) { broken = true; break; }

        const span = count * width;
        if (!Number.isSafeInteger(span) || span > body.length) { broken = true; break; }
        if (at + span + 8 > body.length) { broken = true; break; }
        if (meta) {
          if (metaSize !== span + 24 || metaEnd !== metaSize + 4) { broken = true; break; }
        }
        if (body.readUInt32LE(at + span) !== 0 || body.readUInt32LE(at + span + 4) !== 0) {
          broken = true;
          break;
        }

        const values = [];
        for (let value = 0; value < count; value += 1) {
          const cursor = at + value * width;
          if (type === "Single[]") values.push(body.readFloatLE(cursor));
          else if (type === "Double[]") values.push(body.readDoubleLE(cursor));
          else if (type === "Byte[]") values.push(body.readUInt8(cursor));
          else values.push(body.readUInt32LE(cursor));
        }
        fields.set(name, { type, width, values });
        at += span + 8;
      }
      if (broken) continue;

      return { start, end: at, fieldStart, fields, props, meta };
    }
  }
  return null;
}

/**
 * Replace one curve record of a document, or add it when there is none,
 * whichever flavour the document carries.
 *
 * This is `replaceCurve` for both mixers: a version 0110 document is
 * spliced against the reader's own scan of its fields, and a version 0100
 * document is walked without the size words and rebuilt without them. The
 * bytes around the record, and the record's own head when only its values
 * change, are where the rest of the document lives untouched.
 */
export function spliceCurve(document, { kind, axis = null, fields, pool = null }) {
  const parts = documentParts(document);
  const strings = pool ?? parts.pool;
  const meta = (document.version ?? "0110") !== "0100";
  const record = buildCurveRecord({ pool: strings, kind, axis, fields, meta });

  const found = locateCurve(document, kind, axis);
  let body;
  if (found) {
    body = Buffer.concat([
      parts.body.subarray(0, found.start),
      record,
      parts.body.subarray(found.end),
    ]);
  } else {
    const pad = (4 - (parts.body.length % 4)) % 4;
    body = Buffer.concat([parts.body, Buffer.alloc(pad), record]);
  }

  return buildDocument({ ...parts, pool: strings, body });
}

/**
 * Splice a cell plan into a track document.
 *
 * `plan` gives the cells the track shows, `{ frame, tag }` per cell, in the
 * order they start. The frame is turned into a tick of the document's
 * timebase, the cell names are added to the pool when they are not in it
 * yet, and the curve is rebuilt with the array types the document carries.
 * The value of a cell is its number among the cells of the plan.
 *
 * Both mixers of a track can be spliced this way: the version 0110 one and
 * the version 0100 one, which keeps the same cells in the layout each of
 * them uses.
 */
export function spliceCelPlan(document, plan) {
  const keys = plan?.keys ?? [];
  if (!keys.length) throw new Error("a cell plan needs at least one cell");
  const frameRate = Number(plan.frameRate) > 0 ? Number(plan.frameRate) : 30;

  const pool = withStrings(document.pool, keys.map((key) => key.tag));
  const found = locateCurve(document, "ImageCelName");
  const types = {};
  if (found) {
    for (const [name, field] of found.fields) types[name] = field.type;
  }

  const fields = celCurveFields(
    keys.map((key, index) => ({
      time: tickOfFrame(key.frame, frameRate),
      value: index,
      tag: key.tag,
    })),
    pool,
    types,
  );
  return spliceCurve({ ...document, pool }, { kind: "ImageCelName", fields });
}

/**
 * Splice a camera plan into a track document.
 *
 * A camera track carries six curves: the half size of the frame the camera
 * looks through (`ImageCenter` X and Y), where the middle of that frame sits
 * (`ImagePosition` X and Y), how far the camera is turned (`ImageRotation`)
 * and how much of the canvas it shows (`ImageScale`, in percent).
 *
 * A project stores a camera as a window over the canvas, not as those six
 * numbers: `{ frame, x, y, width, height, rotation }`. The reader folds the
 * centre and the zoom into a window, so writing it back needs a choice. The
 * writer picks the zoom of **100%**, which makes the frame the window itself:
 *
 *   centreX   = width / 2          positionX = x + width / 2
 *   centreY   = height / 2         positionY = y + height / 2
 *   rotation  = rotation           scale     = 100
 *
 * At 100% the reader folds `position - centre * 1` back into the same `x`,
 * the same `y` and the same size, so the window survives the round trip.
 *
 * The times are the 60 Hz ticks of the document, the same as the cells use.
 * Both mixers of a track can be spliced this way, each in the layout it uses.
 */
export function spliceCameraPlan(document, plan) {
  const keys = plan?.keys ?? [];
  if (!keys.length) throw new Error("a camera plan needs at least one key");
  const frameRate = Number(plan.frameRate) > 0 ? Number(plan.frameRate) : 30;
  const startFrame = Number(plan.startFrame) > 0 ? Number(plan.startFrame) : 1;

  const times = keys.map((key) => ((Number(key.frame) - startFrame) * 60) / frameRate);
  const series = [
    ["ImageCenter", "X", keys.map((key) => Number(key.width) / 2)],
    ["ImageCenter", "Y", keys.map((key) => Number(key.height) / 2)],
    ["ImagePosition", "X", keys.map((key) => Number(key.x) + Number(key.width) / 2)],
    ["ImagePosition", "Y", keys.map((key) => Number(key.y) + Number(key.height) / 2)],
    ["ImageRotation", null, keys.map((key) => Number(key.rotation) || 0)],
    ["ImageScale", null, keys.map(() => 100)],
  ];

  // The strings a rebuilt curve refers to, so a document that does not use
  // one of the six curves yet can still hold it afterwards.
  const pool = withStrings(document.pool, [
    "FCurve", "Type", "Axis", "Frame", "Value", "Int32[]", "Double[]", "Single[]",
    "ImageCenter", "ImagePosition", "ImageRotation", "ImageScale", "X", "Y",
  ]);

  let current = { ...document, pool };
  for (const [kind, axis, values] of series) {
    const found = locateCurve(current, kind, axis);
    const types = {};
    if (found) {
      for (const [name, field] of found.fields) types[name] = field.type;
    }
    // A document that writes its other curves as single precision keeps that
    // layout; a curve that is new to it takes the type that goes with the
    // document's version.
    const fallback = (current.version ?? "0110") === "0100" ? "Single[]" : "Double[]";
    const fields = [
      { name: "Frame", type: types.Frame ?? fallback, values: times },
      { name: "Value", type: types.Value ?? fallback, values },
    ];
    current = parseActionDocument(
      spliceCurve(current, { kind, axis, fields, pool: current.pool }),
    );
  }
  return rebuildDocument(current);
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
export function replaceCurve(document, { kind, axis = null, fields, pool = null }) {
  const parts = documentParts(document);
  const strings = pool ?? parts.pool;
  const record = buildCurveRecord({ pool: strings, kind, axis, fields });

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

  return buildDocument({ ...parts, pool: strings, body });
}

/**
 * Patch the `Start`, `End` and `Rate` doubles of the document to new times.
 *
 * A track carries these in its `TimeClip` and, where it moves, in its other
 * clips, and the plain doubles are written as the name, the type and the
 * value, so they are found by that pair. `range` may carry any of the three
 * names; the ones it does not carry are left as they are.
 */
export function setTrackRange(document, range) {
  const parts = documentParts(document);
  const wanted = [
    ["Start", "start"],
    ["End", "end"],
    ["Rate", "rate"],
  ];
  let body = parts.body;
  let patched = 0;
  for (const [name, key] of wanted) {
    const value = range?.[key];
    if (value === undefined || value === null) continue;
    const nameId = parts.pool.indexOf(name);
    const doubleId = parts.pool.indexOf("Double");
    if (nameId < 0 || doubleId < 0) continue;
    body = Buffer.from(body);
    for (let at = 0; at + 16 <= body.length; at += 1) {
      if (body.readUInt32LE(at) !== nameId) continue;
      if (body.readUInt32LE(at + 4) !== doubleId) continue;
      body.writeDoubleLE(Number(value), at + 8);
      patched += 1;
    }
  }
  if (patched === 0) return document;
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
  return setTrackRange(document, { end: ticks });
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
