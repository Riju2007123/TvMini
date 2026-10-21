import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "../public/core/bytes.js";
import {
  ALPHA_TILE,
  decodeRgbaBlock,
  encodeRgbaBlock,
} from "../public/core/clip-blocks.js";

test("a packed tile decodes back to the pixels it was made from", () => {
  const width = 256;
  const height = 256;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const at = index * 4;
    rgba[at] = (index * 7) & 0xff;
    rgba[at + 1] = (index * 13) & 0xff;
    rgba[at + 2] = (index * 29) & 0xff;
    rgba[at + 3] = (index * 3) & 0xff;
  }

  const packed = encodeRgbaBlock(rgba, width, height);
  // The tile carries the colour rows plus ALPHA_TILE rows of folded alpha.
  assert.equal(packed.length, (height + ALPHA_TILE) * width * 4);

  assert.deepEqual(Buffer.from(decodeRgbaBlock(packed, width, height)), rgba);
});

test("a tile that is plain pixels decodes without the folded alpha rows", () => {
  // Clip Studio also writes tiles that are just the pixels themselves: the
  // buffer is exactly the tile, in blue, green, red, alpha order.
  const width = 2;
  const height = 2;
  const raw = Buffer.from([
    10, 20, 30, 40, // blue, green, red, alpha
    50, 60, 70, 80,
    90, 100, 110, 120,
    130, 140, 150, 160,
  ]);

  const out = decodeRgbaBlock(raw, width, height);

  assert.deepEqual([...out.subarray(0, 8)], [30, 20, 10, 40, 70, 60, 50, 80]);
  assert.deepEqual([...out.subarray(8, 16)], [110, 100, 90, 120, 150, 140, 130, 160]);
});

test("a short tile does not throw", () => {
  // A tile shorter than its own header claims used to read past the end.
  const raw = Buffer.alloc(16);
  const out = decodeRgbaBlock(raw, 4, 8);
  assert.equal(out.length, 4 * 8 * 4);
});
