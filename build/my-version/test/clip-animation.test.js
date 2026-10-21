import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "../public/core/bytes.js";
import {
  celPlacement,
  celPlacementFromKeys,
  readCelCurve,
  readCelSequence,
  readTrackRange,
} from "../public/core/clip-animation.js";

/**
 * A body made of 32-bit little endian words, which is how the cell sequence
 * of a real action document is stored.
 */
function bodyOf(values) {
  const bytes = [];
  for (const value of values) {
    bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  }
  return Buffer.from(bytes);
}

const POOL = ["null", "Byte", "Int32", "Param", "ImageCelName", "Tag", "1", "2", "3"];

test("the cell sequence is read from the pool indices of the body", () => {
  // 3 is ImageCelName, 6 to 8 are the cells, and the run is what counts.
  const document = { pool: POOL, body: bodyOf([3, 6, 7, 8, 0]) };
  assert.deepEqual(readCelSequence(document), ["1", "2", "3"]);
});

test("the cell sequence is found whatever the offset of the run", () => {
  const document = { pool: POOL, body: bodyOf([0, 0, 0, 3, 7, 8, 6]) };
  assert.deepEqual(readCelSequence(document), ["2", "3", "1"]);
});

test("a single cell is not called a sequence", () => {
  // One index on its own cannot be told apart from the other small numbers.
  const document = { pool: POOL, body: bodyOf([3, 6, 0, 0]) };
  assert.equal(readCelSequence(document), null);
});

test("a document without cells has no sequence", () => {
  const document = { pool: ["null", "Byte", "Param"], body: bodyOf([0, 1, 2, 0]) };
  assert.equal(readCelSequence(document), null);
});

test("a cell that holds frames in a row is held for all of them", () => {
  const placement = celPlacement(["1", "1", "1", "2"], 5);
  assert.deepEqual(placement.get("1"), [{ frame: 5, hold: 3 }]);
  assert.deepEqual(placement.get("2"), [{ frame: 8, hold: 1 }]);
});

test("a cell that comes back later gets a drawing for each time", () => {
  const placement = celPlacement(["1", "2", "1"], 1);
  assert.deepEqual(placement.get("1"), [
    { frame: 1, hold: 1 },
    { frame: 3, hold: 1 },
  ]);
  assert.deepEqual(placement.get("2"), [{ frame: 2, hold: 1 }]);
});

/* ------------------------------------------------------------- cell curves */

/**
 * A string pool with the type names a real document starts with, followed by
 * the names a cell curve uses.
 */
const CURVE_POOL = [
  "null", "Byte", "SByte", "UInt16", "Int16", "UInt32", "Int32", "Single",
  "Double", "String", "Double2", "Double3", "Quat", "Matrix44",
  "Double[]", "Byte[]", "Int32[]", "String[]",
  "Double2[]", "Double3[]", "Quat[]", "Matrix44[]",
  "celsysdocument", "version", "1.0.0",
  "FCurve", "Type", "ImageCelName", "Frame", "Value", "Tag",
  "Start", "End", "Rate", "1", "2", "3",
];

/** A byte writer for the little endian words and doubles of a body. */
function writer() {
  const bytes = [];
  return {
    u32(value) {
      bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
      return this;
    },
    f64(value) {
      const word = Buffer.alloc(8);
      word.writeDoubleLE(value, 0);
      for (const byte of word) bytes.push(byte);
      return this;
    },
    done() {
      return Buffer.from(bytes);
    },
  };
}

/**
 * One curve record: an `FCurve` of the given kind with `Frame`, `Value` and
 * `Tag` arrays, in the exact layout Clip Studio Paint writes.
 */
function curveBody({ times, tags, values, kind = "ImageCelName", pool = CURVE_POOL }) {
  const index = (name) => pool.indexOf(name);
  const out = writer();
  out.u32(index("FCurve")).u32(0).u32(1);
  out.u32(index("Type")).u32(index(kind));

  const fields = [
    ["Frame", "Double[]", times, true],
    ["Value", "Double[]", values ?? times.map((_, at) => at), true],
    ["Tag", "String[]", tags.map((tag) => index(tag)), false],
  ];
  out.u32(fields.length);
  for (const [name, type, list, wide] of fields) {
    const width = list.length * (wide ? 8 : 4);
    // The three words of array metadata, then the name, the type and count.
    out.u32(index("Int32[]")).u32(width + 24).u32(width + 28);
    out.u32(index(name)).u32(index(type)).u32(list.length);
    for (const value of list) (wide ? out.f64(value) : out.u32(value));
    out.u32(0).u32(0);
  }
  return out.done();
}

test("the cell curve gives the time and the name of every key", () => {
  const body = curveBody({ times: [0, 4, 8], tags: ["1", "2", "3"] });
  const curve = readCelCurve({ pool: CURVE_POOL, body });
  assert.deepEqual(curve.keys, [
    { time: 0, value: 0, tag: "1" },
    { time: 4, value: 1, tag: "2" },
    { time: 8, value: 2, tag: "3" },
  ]);
});

test("a curve of another kind is not a cell curve", () => {
  const body = curveBody({ times: [0], tags: ["1"], kind: "ImagePosition" });
  assert.equal(readCelCurve({ pool: CURVE_POOL, body }), null);
});

test("a broken field size is not read as a curve", () => {
  const body = curveBody({ times: [0, 4], tags: ["1", "2"] });
  // The first field says its array is larger than it is.
  body[28] = 0xff;
  assert.equal(readCelCurve({ pool: CURVE_POOL, body }), null);
});

test("key times are 60 Hz ticks, so a 30 fps document halves them", () => {
  const keys = [
    { time: 0, tag: "1" },
    { time: 4, tag: "2" },
    { time: 8, tag: "3" },
  ];
  const placement = celPlacementFromKeys(keys, { frameRate: 30, startFrame: 1, endFrame: 17, endTick: 16 });
  assert.deepEqual(placement.get("1"), [{ frame: 1, hold: 2 }]);
  assert.deepEqual(placement.get("2"), [{ frame: 3, hold: 2 }]);
  // The last cell is held to the end of the track, frame 1 + 16/2 = 9.
  assert.deepEqual(placement.get("3"), [{ frame: 5, hold: 5 }]);
});

test("a 24 fps document turns 2.5 tick steps into whole frames", () => {
  const keys = [0, 2.5, 5, 7.5].map((time, at) => ({ time, tag: String(at + 1) }));
  const placement = celPlacementFromKeys(keys, { frameRate: 24, startFrame: 1, endFrame: 21, endTick: 10 });
  assert.deepEqual(placement.get("1"), [{ frame: 1, hold: 1 }]);
  assert.deepEqual(placement.get("2"), [{ frame: 2, hold: 1 }]);
  assert.deepEqual(placement.get("3"), [{ frame: 3, hold: 1 }]);
  assert.deepEqual(placement.get("4"), [{ frame: 4, hold: 2 }]);
});

test("the track range is read from the TimeClip doubles", () => {
  const out = writer();
  const index = (name) => CURVE_POOL.indexOf(name);
  // A plain double is written as its name, its type, and then the value.
  out.u32(index("Start")).u32(index("Double")).f64(0);
  out.u32(index("End")).u32(index("Double")).f64(248);
  out.u32(index("Rate")).u32(index("Double")).f64(60);
  assert.deepEqual(readTrackRange({ pool: CURVE_POOL, body: out.done() }), {
    start: 0,
    end: 248,
    rate: 60,
  });
});

test("a cell that starts twice keeps both keys", () => {
  const keys = [
    { time: 0, tag: "1" },
    { time: 4, tag: "2" },
    { time: 8, tag: "1" },
  ];
  const placement = celPlacementFromKeys(keys, { frameRate: 30, startFrame: 1, endFrame: 6 });
  assert.deepEqual(placement.get("1"), [
    { frame: 1, hold: 2 },
    { frame: 5, hold: 2 },
  ]);
  assert.deepEqual(placement.get("2"), [{ frame: 3, hold: 2 }]);
});
