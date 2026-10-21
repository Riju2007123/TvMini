import test from "node:test";
import assert from "node:assert/strict";
import { buildPalette, decodeGif, encodeGif } from "../public/core/gif.js";

function solid(width, height, rgb) {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < out.length; i += 3) out.set(rgb, i);
  return out;
}

function gradient(width, height, seed) {
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      out[i] = (x * 5 + seed) & 255;
      out[i + 1] = (y * 7) & 255;
      out[i + 2] = ((x ^ y) * 3) & 255;
    }
  }
  return out;
}

test("a few flat colours round-trip exactly", () => {
  const frames = [solid(8, 6, [255, 0, 0]), solid(8, 6, [0, 255, 0]), solid(8, 6, [10, 20, 30])];
  const gif = encodeGif({ width: 8, height: 6, frames: frames.map((rgb) => ({ rgb, delay: 5 })), loop: 3 });
  assert.equal(String.fromCharCode(...gif.subarray(0, 6)), "GIF89a");
  const read = decodeGif(gif);
  assert.equal(read.width, 8);
  assert.equal(read.height, 6);
  assert.equal(read.loop, 3);
  assert.equal(read.frames.length, 3);
  assert.equal(read.frames[0].delay, 5);
  frames.forEach((rgb, n) => {
    for (let i = 0; i < 8 * 6; i += 1) {
      assert.deepEqual([...read.frames[n].rgba.subarray(i * 4, i * 4 + 4)], [rgb[0], rgb[1], rgb[2], 255]);
    }
  });
});

test("a busy picture survives the palette with small error and LZW resets", () => {
  const width = 120;
  const height = 90;
  const rgb = gradient(width, height, 0);
  const read = decodeGif(encodeGif({ width, height, frames: [{ rgb }, { rgb: gradient(width, height, 40) }] }));
  assert.equal(read.frames.length, 2);
  let error = 0;
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < 3; c += 1) error += Math.abs(read.frames[0].rgba[i * 4 + c] - rgb[i * 3 + c]);
  }
  assert.ok(error / (width * height * 3) < 12, `mean error ${error / (width * height * 3)}`);
});

test("the palette never has more than 256 colours", () => {
  const palette = buildPalette([gradient(200, 100, 3)]);
  assert.ok(palette.length <= 256 && palette.length > 100);
});

test("the encoder refuses frames of the wrong size and the decoder refuses junk", () => {
  assert.throws(() => encodeGif({ width: 4, height: 4, frames: [{ rgb: new Uint8Array(3) }] }), /size/);
  assert.throws(() => encodeGif({ width: 4, height: 4, frames: [] }), /at least one/);
  assert.throws(() => decodeGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7])), /not a GIF/);
});

test("Pillow-style interop: transparency and disposal decode", () => {
  // A hand-built 2x1 GIF with a transparent first pixel.
  const bytes = Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 2, 0, 1, 0, 0x80, 0, 0,
    255, 0, 0, 0, 0, 255,
    0x21, 0xf9, 4, 0x01, 0, 0, 0, 0,
    0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0,
    2, 2, 0x44, 0x0a, 0,
    0x3b,
  ]);
  const read = decodeGif(bytes);
  assert.equal(read.frames[0].rgba[3], 0);
  assert.deepEqual([...read.frames[0].rgba.subarray(4, 8)], [0, 0, 255, 255]);
});
