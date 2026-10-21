import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createProject } from "../src/model.js";
import {
  createGifBuffer,
  createSequenceZip,
  createSpriteSheet,
  createZip,
  expandPattern,
  frameRange,
  importPictures,
  readZip,
  safeFileName,
} from "../public/core/exporters.js";
import { decodeGif, encodeGif } from "../public/core/gif.js";
import { decodeBmp, decodeImage, decodeTga, encodeTga, sniffImage } from "../public/core/imageio.js";
import { decodePng, encodeRgbaPng } from "../public/core/png.js";

const dot = (color, x, y) => ({ color, width: 8, points: [[x, y], [x + 1, y]] });

function animated() {
  const project = createProject(40, 30);
  const layer = createLayer("L");
  layer.drawings = [
    { at: 1, hold: 2, strokes: [dot("#ff0000", 10, 10)] },
    { at: 3, hold: 1, strokes: [dot("#0000ff", 30, 20)] },
  ];
  project.layers = [layer];
  project.fps = 10;
  return project;
}

test("patterns pad numbers and keep unknown words", () => {
  assert.equal(expandPattern("{name}_{frame:4}", { name: "shot", frame: 7 }), "shot_0007");
  assert.equal(expandPattern("{nope}-{frame}", { frame: 3 }), "{nope}-3");
  assert.equal(safeFileName('a/b:c*"d'), "a_b_c__d");
  assert.equal(safeFileName("..."), "_");
});

test("the frame range is the content, or what was asked for", () => {
  const project = animated();
  assert.deepEqual(frameRange(project, "all"), [1, 2, 3]);
  assert.deepEqual(frameRange(project, { from: 2, to: 99 }), [2, 3]);
  project.currentFrame = 2;
  assert.deepEqual(frameRange(project, "current"), [2]);
});

test("the GIF has one image per frame at the project's frame rate", () => {
  const { buffer, frames, width, height } = createGifBuffer(animated());
  assert.equal(frames, 3);
  const gif = decodeGif(buffer);
  assert.equal(gif.width, width);
  assert.equal(gif.height, height);
  assert.equal(gif.frames.length, 3);
  assert.equal(gif.frames[0].delay, 10); // 10 fps = 10 hundredths
  const at = (frame, x, y) => [...gif.frames[frame].rgba.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)];
  assert.deepEqual(at(0, 10, 10), [255, 0, 0]);
  assert.deepEqual(at(2, 30, 20), [0, 0, 255]);
  assert.deepEqual(at(2, 10, 10), [255, 255, 255]);
});

test("the sprite sheet lays frames out in a grid and describes them", () => {
  const sheet = createSpriteSheet(animated(), { columns: 2, name: "hero" });
  assert.equal(sheet.columns, 2);
  assert.equal(sheet.rows, 2);
  assert.equal(sheet.width, 80);
  assert.equal(sheet.height, 60);
  const description = JSON.parse(sheet.json);
  assert.equal(description.image, "hero.png");
  assert.deepEqual(description.frames[2], { frame: 3, x: 0, y: 30, w: 40, h: 30 });
  const png = decodePng(sheet.png);
  const px = (x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  assert.deepEqual(px(10, 10), [255, 0, 0]); // frame 1, top left cell
  assert.deepEqual(px(40 + 10, 10), [255, 0, 0]); // frame 2 (the hold), top right
  assert.deepEqual(px(30, 30 + 20), [0, 0, 255]); // frame 3, bottom left
});

test("ZIP round-trips and detects damage", () => {
  const zip = createZip([
    { name: "a.txt", data: new TextEncoder().encode("hello") },
    { name: "dir/ü.bin", data: Uint8Array.from([1, 2, 3]) },
  ]);
  const files = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ["a.txt", "dir/ü.bin"]);
  assert.equal(Buffer.from(files[0].data).toString(), "hello");
  const bad = Buffer.from(zip);
  bad[30 + 5] ^= 0xff; // flip a byte of the first name/data area
  assert.throws(() => readZip(bad));
});

test("the image sequence names its files by pattern and holds real pictures", () => {
  const out = createSequenceZip(animated(), { pattern: "{name}.{frame:3}", name: "walk" });
  assert.deepEqual(out.names, ["walk.001.png", "walk.002.png", "walk.003.png"]);
  const files = readZip(out.buffer);
  assert.equal(files.length, 3);
  const third = decodePng(files[2].data);
  assert.equal(third.width, 40);
  assert.deepEqual([...third.data.subarray((20 * 40 + 30) * 4, (20 * 40 + 30) * 4 + 3)], [0, 0, 255]);
  const tga = createSequenceZip(animated(), { format: "tga", range: "current" });
  assert.match(tga.names[0], /\.tga$/);
});

test("TGA round-trips, including RLE and bottom-up files", () => {
  const rgba = new Uint8Array(4 * 3 * 4);
  for (let i = 0; i < 12; i += 1) rgba.set([i * 20, 255 - i * 10, i, i % 2 ? 255 : 128], i * 4);
  const back = decodeTga(encodeTga(4, 3, rgba));
  assert.deepEqual(back.data, rgba);

  // Hand-built bottom-up RLE 24-bit 2x2: top row red, bottom row blue.
  const header = Buffer.alloc(18);
  header[2] = 10;
  header.writeUInt16LE(2, 12);
  header.writeUInt16LE(2, 14);
  header[16] = 24;
  const rle = Buffer.from([0x81, 255, 0, 0, 0x81, 0, 0, 255]); // BGR: blue-pixel run first (bottom row)
  const rleImage = decodeTga(Buffer.concat([header, rle]));
  assert.deepEqual([...rleImage.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...rleImage.data.subarray(8, 12)], [0, 0, 255, 255]);
});

function makeBmp(width, height, pixel, bits = 24) {
  const bytesPer = bits / 8;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const out = Buffer.alloc(54 + stride * height);
  out.write("BM");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(bits, 28);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = 54 + (height - 1 - y) * stride + x * bytesPer;
      out[at] = b;
      out[at + 1] = g;
      out[at + 2] = r;
      if (bytesPer === 4) out[at + 3] = a;
    }
  }
  return out;
}

test("BMP reads 24 and 32 bit files, bottom-up with row padding", () => {
  const pixel = (x, y) => [x * 40, y * 60, 7, 255];
  const bmp = decodeBmp(makeBmp(5, 3, pixel));
  assert.equal(bmp.width, 5);
  assert.deepEqual([...bmp.data.subarray((2 * 5 + 4) * 4, (2 * 5 + 4) * 4 + 4)], [160, 120, 7, 255]);
  const withAlpha = decodeBmp(makeBmp(2, 2, (x, y) => [1, 2, 3, x ? 100 : 255], 32));
  assert.equal(withAlpha.data[3], 255);
  assert.equal(withAlpha.data[7], 100);
  assert.throws(() => decodeBmp(Buffer.from("nope")), /not a BMP/);
});

test("pictures are recognised by their first bytes", () => {
  assert.equal(sniffImage(encodeRgbaPng(2, 2, new Uint8Array(16))), "png");
  assert.equal(sniffImage(makeBmp(2, 2, () => [0, 0, 0, 255])), "bmp");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff])), "jpeg");
  assert.throws(() => decodeImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), /JPEG/);
});

test("importing a still makes a one-cell project, padded up to the minimum size", () => {
  const png = encodeRgbaPng(8, 8, new Uint8Array(8 * 8 * 4).fill(255));
  const project = importPictures([{ name: "tiny.png", bytes: png }]);
  assert.equal(project.width, 16);
  assert.equal(project.layers.length, 1);
  assert.equal(project.layers[0].drawings.length, 1);
  assert.equal(project.layers[0].name, "tiny");
});

test("importing several pictures makes a sequence of cells", () => {
  const a = encodeRgbaPng(20, 20, new Uint8Array(20 * 20 * 4).fill(200));
  const project = importPictures([
    { name: "a.png", bytes: a },
    { name: "b.bmp", bytes: makeBmp(20, 20, () => [9, 9, 9, 255]) },
  ]);
  assert.deepEqual(project.layers[0].drawings.map((d) => [d.at, d.name]), [[1, "a"], [2, "b"]]);
});

test("importing a GIF keeps its timing as exposures and its frame rate", () => {
  const frame = (v) => ({ rgb: new Uint8Array(20 * 20 * 3).fill(v), delay: 10 });
  const gif = encodeGif({ width: 20, height: 20, frames: [frame(0), { ...frame(255), delay: 30 }] });
  const project = importPictures([{ name: "loop.gif", bytes: gif }]);
  assert.equal(project.fps, 10);
  assert.deepEqual(project.layers[0].drawings.map((d) => [d.at, d.hold]), [[1, 1], [2, 3]]);
});
