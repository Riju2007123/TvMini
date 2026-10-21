import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "../public/core/bytes.js";
import { celPlacement, readCelSequence } from "../public/core/clip-animation.js";

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
