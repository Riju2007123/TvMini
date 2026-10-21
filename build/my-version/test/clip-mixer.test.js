import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "../public/core/bytes.js";
import { readActionBlob, readCelCurve, readTrackRange } from "../public/core/clip-animation.js";
import {
  buildCurveRecord,
  buildDocument,
  celCurveFields,
  crc32,
  decodeMixerPayload,
  documentParts,
  encodeMixerPayload,
  mixerColumnSize,
  newMixerId,
  rebuildDocument,
  replaceCurve,
  setTrackEnd,
  withStrings,
} from "../public/core/clip-mixer.js";
import { parseActionDocument } from "../public/core/clip-animation.js";

/**
 * The pool a document starts with: the types first, then the names a cell
 * track uses. The reader finds the type names by their position, so the order
 * matters as much as the words do.
 */
const POOL = [
  "null", "Byte", "SByte", "UInt16", "Int16", "UInt32", "Int32", "Single",
  "Double", "String", "Double2", "Double3", "Quat", "Matrix44",
  "Double[]", "Byte[]", "Int32[]", "String[]", "Double2[]", "Double3[]",
  "Quat[]", "Matrix44[]",
  "celsysdocument", "TimeClip", "Start", "End", "Rate", "FCurve", "Type",
  "ImageCelName", "Frame", "Value", "LeftSlope", "RightSlope", "Interp",
  "Tag", "Constant", "1", "2", "3",
];

/** The three keys used by most tests: two cells, the second held longer. */
const KEYS = [
  { time: 0, value: 0, tag: "1" },
  { time: 10, value: 1, tag: "2" },
];

/** A document with one cell curve, and the range records a track carries. */
function documentWith(keys, { end = 32 } = {}) {
  const pool = withStrings(POOL, keys.map((key) => key.tag));
  const curve = buildCurveRecord({
    pool,
    kind: "ImageCelName",
    fields: celCurveFields(keys, pool),
  });
  const range = Buffer.concat([
    rangeRecord(pool, "Start", 0),
    rangeRecord(pool, "End", end),
    rangeRecord(pool, "Rate", 30),
  ]);
  return buildDocument({ pool, body: Buffer.concat([range, curve]) });
}

function rangeRecord(pool, name, value) {
  const words = Buffer.alloc(16);
  words.writeUInt32LE(pool.indexOf(name), 0);
  words.writeUInt32LE(pool.indexOf("Double"), 4);
  words.writeDoubleLE(value, 8);
  return words;
}

test("the checksum is the CRC-32 of everything from offset 16", () => {
  assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  const bytes = documentWith(KEYS);
  assert.equal(bytes.readUInt32LE(12), crc32(bytes.subarray(16)));
});

test("a document is rebuilt from its parts byte for byte", () => {
  const bytes = documentWith(KEYS);
  const document = parseActionDocument(bytes);
  assert.equal(Buffer.compare(rebuildDocument(document), bytes), 0);
});

test("a cell curve is read back after it has been written", () => {
  const document = parseActionDocument(documentWith(KEYS));
  const curve = readCelCurve(document);
  assert.deepEqual(curve.keys, KEYS);
});

test("the range records are read back as plain doubles", () => {
  const document = parseActionDocument(documentWith(KEYS, { end: 32 }));
  assert.deepEqual(readTrackRange(document), { start: 0, end: 32, rate: 30 });
});

test("a curve can gain and lose a key without touching anything before it", () => {
  const document = parseActionDocument(documentWith(KEYS));
  const pool = withStrings(document.pool, ["3"]);

  const longer = replaceCurve(document, {
    kind: "ImageCelName",
    fields: celCurveFields([...KEYS, { time: 20, value: 2, tag: "3" }], pool),
  });
  const grown = readCelCurve(parseActionDocument(longer));
  assert.equal(grown.keys.length, 3);
  assert.deepEqual(grown.keys.at(-1), { time: 20, value: 2, tag: "3" });

  const shorter = replaceCurve(document, {
    kind: "ImageCelName",
    fields: celCurveFields([KEYS[0]], pool),
  });
  const shrunk = readCelCurve(parseActionDocument(shorter));
  assert.deepEqual(shrunk.keys, [KEYS[0]]);
});

test("the edit leaves the rest of the document alone", () => {
  const document = parseActionDocument(documentWith(KEYS));
  const pool = withStrings(document.pool, ["3"]);
  const changed = parseActionDocument(
    replaceCurve(document, {
      kind: "ImageCelName",
      fields: celCurveFields([...KEYS, { time: 20, value: 2, tag: "3" }], pool),
    }),
  );
  assert.deepEqual(readTrackRange(changed), readTrackRange(document));
  assert.deepEqual(changed.pool, pool);
});

test("the end of a track is patched wherever it is written", () => {
  const document = parseActionDocument(documentWith(KEYS, { end: 32 }));
  const patched = parseActionDocument(setTrackEnd(document, 60));
  assert.deepEqual(readTrackRange(patched), { start: 0, end: 60, rate: 30 });
  // Two records carry an `End` in a real track; both are patched.
  assert.equal(document.body.readDoubleLE(24), 32);
});

test("a document survives the external chunk it travels in", () => {
  const bytes = documentWith(KEYS);
  const id = newMixerId();
  assert.equal(id.length, 40);
  assert.ok(id.startsWith("extrnlid"));

  const payload = encodeMixerPayload(bytes, id);
  // The locator, its length, the compressed length and the stream.
  assert.equal(Number(payload.readBigUInt64BE(0)), 40);
  assert.equal(payload.toString("ascii", 8, 48), id);
  assert.equal(Number(payload.readBigUInt64BE(48)), payload.length - 56);
  assert.equal(payload.readUInt32LE(56), payload.length - 60);

  const back = decodeMixerPayload(payload);
  assert.equal(Buffer.compare(Buffer.from(back.raw), bytes), 0);
  assert.equal(mixerColumnSize(bytes), bytes.length);
});

test("a string is only added to a pool when it is missing", () => {
  const pool = withStrings(POOL, ["9", "10", "1"]);
  assert.equal(pool.length, POOL.length + 2);
  assert.equal(pool[POOL.length], "9");
  assert.equal(pool[POOL.length + 1], "10");
  // Every existing index still names the same string.
  assert.equal(pool[POOL.indexOf("Frame")], "Frame");
});

test("a document without the curve gains one when it is written", () => {
  const pool = withStrings(POOL, ["1", "2"]);
  const empty = buildDocument({ pool, body: rangeRecord(pool, "End", 0) });
  const document = parseActionDocument(empty);
  assert.equal(readCelCurve(document), null);

  const written = parseActionDocument(
    replaceCurve(document, { kind: "ImageCelName", fields: celCurveFields(KEYS, pool) }),
  );
  assert.deepEqual(readCelCurve(written).keys, KEYS);
});

test("a rebuilt document keeps the word after the pool", () => {
  const bytes = documentWith(KEYS);
  const document = parseActionDocument(bytes);
  assert.equal(document.typeCount, 0);
  assert.equal(rebuildDocument(document).readUInt32LE(document.bodyOffset), 0);
  assert.deepEqual(documentParts(document).pool, document.pool);
});

test("an external chunk with a broken locator is refused", () => {
  assert.throws(() => encodeMixerPayload(Buffer.alloc(20), "short-id"), /40 characters/);
});

test("an empty payload is read as no document", () => {
  assert.equal(readActionBlob(null), null);
  assert.equal(readActionBlob(Buffer.alloc(8)), null);
});
