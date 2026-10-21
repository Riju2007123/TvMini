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
  locateCurve,
  mixerColumnSize,
  newMixerId,
  rebuildDocument,
  replaceCurve,
  setTrackEnd,
  setTrackRange,
  spliceCelPlan,
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
  "Double[]", "Single[]", "Byte[]", "Int32[]", "String[]", "Double2[]",
  "Double3[]", "Quat[]", "Matrix44[]",
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

/**
 * A document in the older flavour.
 *
 * A version 0100 mixer writes the same record without the three size words
 * in front of every field, and stores its times as `Single[]` where the
 * newer flavour uses `Double[]`. The reader does not understand that
 * flavour; the writer does.
 */
const OLD_TYPES = {
  Frame: "Single[]",
  Value: "Single[]",
  LeftSlope: "Single[]",
  RightSlope: "Single[]",
};

function oldDocumentWith(keys, { end = 32 } = {}) {
  const pool = withStrings(POOL, keys.map((key) => key.tag));
  const curve = buildCurveRecord({
    pool,
    kind: "ImageCelName",
    fields: celCurveFields(keys, pool, OLD_TYPES),
    meta: false,
  });
  const range = Buffer.concat([
    rangeRecord(pool, "Start", 0),
    rangeRecord(pool, "End", end),
    rangeRecord(pool, "Rate", 30),
  ]);
  return buildDocument({ version: "0100", pool, body: Buffer.concat([range, curve]) });
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

test("a cell curve can use names the document did not have", () => {
  const document = parseActionDocument(documentWith(KEYS));
  // "1" and "2" are already in this document's pool; these two are not.
  const keys = [
    { time: 0, value: 0, tag: "9" },
    { time: 4, value: 1, tag: "8a" },
  ];
  const pool = withStrings(document.pool, keys.map((key) => key.tag));
  const written = replaceCurve(document, {
    kind: "ImageCelName",
    fields: celCurveFields(keys, pool),
    pool,
  });
  const read = parseActionDocument(written);
  // The names have to be in the pool the document is written with, or the
  // tag values point past its end and the curve reads back empty.
  assert.ok(read.pool.includes("9"));
  assert.ok(read.pool.includes("8a"));
  assert.deepEqual(readCelCurve(read).keys, keys);
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

test("the older flavour is found even though the reader does not read it", () => {
  const document = parseActionDocument(oldDocumentWith(KEYS));
  // The reader only walks the newer flavour, so it sees no cells at all.
  assert.equal(readCelCurve(document), null);

  const found = locateCurve(document, "ImageCelName");
  assert.ok(found, "the older flavour holds a cell curve");
  assert.equal(found.meta, false);
  assert.deepEqual(
    [...found.fields.keys()],
    ["Frame", "Value", "LeftSlope", "RightSlope", "Interp", "Tag"],
  );
  assert.deepEqual(found.fields.get("Frame").values, [0, 10]);
  assert.deepEqual(found.fields.get("Frame").type, "Single[]");
  assert.deepEqual(
    found.fields.get("Tag").values,
    [document.pool.indexOf("1"), document.pool.indexOf("2")],
  );
});

test("a cell plan is written into a track of either flavour", () => {
  for (const bytes of [documentWith(KEYS), oldDocumentWith(KEYS)]) {
    const document = parseActionDocument(bytes);
    const spliced = spliceCelPlan(document, {
      keys: [
        { frame: 1, tag: "1" },
        { frame: 5, tag: "2" },
      ],
      frameRate: 24,
    });
    const back = parseActionDocument(spliced);
    const found = locateCurve(back, "ImageCelName");
    assert.ok(found);
    // A frame of 24 fps sits 2.5 ticks after the one before it.
    assert.deepEqual(found.fields.get("Frame").values, [0, 10]);
    // A cell is numbered by its place in the plan.
    assert.deepEqual(found.fields.get("Value").values, [0, 1]);
    assert.deepEqual(
      found.fields.get("Tag").values.map((index) => back.pool[index]),
      ["1", "2"],
    );
    // The cells hold, so every span is a constant one.
    assert.deepEqual(
      found.fields.get("Interp").values,
      [back.pool.indexOf("Constant"), back.pool.indexOf("Constant")],
    );
  }
});

test("a plan written back into a track leaves it byte for byte", () => {
  for (const bytes of [documentWith(KEYS), oldDocumentWith(KEYS)]) {
    const document = parseActionDocument(bytes);
    const spliced = spliceCelPlan(document, {
      keys: [
        { frame: 1, tag: "1" },
        { frame: 5, tag: "2" },
      ],
      frameRate: 24,
    });
    assert.equal(Buffer.compare(Buffer.from(spliced), bytes), 0);
  }
});

test("a cell that is not in the pool yet is added to it", () => {
  const document = parseActionDocument(documentWith(KEYS));
  const spliced = spliceCelPlan(document, {
    keys: [
      { frame: 1, tag: "1" },
      { frame: 5, tag: "9" },
    ],
    frameRate: 24,
  });
  const back = parseActionDocument(spliced);
  const found = locateCurve(back, "ImageCelName");
  assert.deepEqual(
    found.fields.get("Tag").values.map((index) => back.pool[index]),
    ["1", "9"],
  );
  assert.ok(back.pool.includes("9"));
});

test("a plan of frames becomes ticks of the document's timebase", () => {
  const document = parseActionDocument(documentWith(KEYS));
  const spliced = spliceCelPlan(document, {
    keys: [
      { frame: 1, tag: "1" },
      { frame: 9, tag: "2" },
    ],
    frameRate: 24,
  });
  const found = locateCurve(parseActionDocument(spliced), "ImageCelName");
  // Frames 1 and 9 of a 24 fps document are ticks 0 and 20.
  assert.deepEqual(found.fields.get("Frame").values, [0, 20]);
});

test("the start, the end and the rate of a track are patched together", () => {
  const document = parseActionDocument(documentWith(KEYS, { end: 32 }));
  const patched = parseActionDocument(
    setTrackRange(document, { start: 2.5, end: 300, rate: 60 }),
  );
  assert.deepEqual(readTrackRange(patched), { start: 2.5, end: 300, rate: 60 });
  // A range that names only one of the three leaves the others alone.
  const onlyEnd = parseActionDocument(setTrackRange(document, { end: 120 }));
  assert.deepEqual(readTrackRange(onlyEnd), { start: 0, end: 120, rate: 30 });
});

test("a plan without any cell is refused", () => {
  const document = parseActionDocument(documentWith(KEYS));
  assert.throws(
    () => spliceCelPlan(document, { keys: [], frameRate: 24 }),
    /at least one cell/,
  );
});

test("a plan is written into a track that has no curve yet", () => {
  const pool = withStrings(POOL, ["1", "2"]);
  const empty = buildDocument({ pool, body: rangeRecord(pool, "End", 0) });
  const document = parseActionDocument(empty);
  const spliced = spliceCelPlan(document, {
    keys: [
      { frame: 1, tag: "1" },
      { frame: 5, tag: "2" },
    ],
    frameRate: 24,
  });
  const found = locateCurve(parseActionDocument(spliced), "ImageCelName");
  assert.ok(found);
  assert.deepEqual(found.fields.get("Frame").values, [0, 10]);
});
