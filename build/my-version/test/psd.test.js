import test from "node:test";
import assert from "node:assert/strict";
import { createGroup, createLayer, createProject } from "../src/model.js";
import { createPsdBuffer, packBitsRow, unpackBitsRow } from "../public/core/psd.js";
import { renderLayerRgba } from "../public/core/png.js";

const stroke = (color, x0, y0, x1, y1) => ({ color, width: 6, points: [[x0, y0], [x1, y1]] });

function sample() {
  const project = createProject(64, 48);
  const folder = createGroup("Animation folder");
  const inner = createGroup("Inner");
  const a = createLayer("1");
  const b = createLayer("Ink");
  const c = createLayer("Colour");
  project.layers = [folder, a, inner, b, c];
  a.parent = 0;
  inner.parent = 0;
  b.parent = 2;
  c.parent = -1;
  a.drawings = [{ at: 1, hold: 1, strokes: [stroke("#ff0000", 10, 10, 40, 10)] }];
  b.drawings = [{ at: 1, hold: 1, strokes: [stroke("#0000ff", 5, 30, 50, 30)] }];
  b.opacity = 0.5;
  b.visible = false;
  c.clip = true;
  c.drawings = [{ at: 1, hold: 1, strokes: [stroke("#00ff00", 0, 0, 20, 20)] }];
  project.currentFrame = 1;
  return project;
}

/** A minimal independent PSD reader: just enough to check the writer. */
function readPsd(buffer) {
  let p = 0;
  const u8 = () => buffer[p++];
  const u16 = () => ((p += 2), buffer.readUInt16BE(p - 2));
  const i16 = () => ((p += 2), buffer.readInt16BE(p - 2));
  const u32 = () => ((p += 4), buffer.readUInt32BE(p - 4));
  const skip = () => {
    const n = u32();
    p += n;
  };
  const i32 = () => ((p += 4), buffer.readInt32BE(p - 4));
  const sig = buffer.toString("latin1", 0, 4);
  p = 4;
  const version = u16();
  p += 6;
  const channels = u16();
  const height = u32();
  const width = u32();
  const depth = u16();
  const mode = u16();
  skip(); // colour mode data
  skip(); // image resources
  const sectionLength = u32();
  const sectionEnd = p + sectionLength;
  const infoLength = u32();
  const infoEnd = p + infoLength;
  const count = i16();
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const r = { top: i32(), left: i32(), bottom: i32(), right: i32() };
    const n = u16();
    r.channels = [];
    for (let k = 0; k < n; k += 1) r.channels.push({ id: i16(), length: u32() });
    p += 4; // 8BIM
    r.blend = buffer.toString("latin1", p, p + 4);
    p += 4;
    r.opacity = u8();
    r.clipping = u8();
    r.flags = u8();
    p += 1;
    const extraLength = u32();
    const extraEnd = p + extraLength;
    skip(); // mask
    skip(); // blending ranges
    const nameLen = u8();
    r.name = buffer.toString("latin1", p, p + nameLen);
    p += Math.ceil((1 + nameLen) / 4) * 4 - 1;
    r.section = null;
    while (p < extraEnd) {
      p += 4;
      const key = buffer.toString("latin1", p, p + 4);
      p += 4;
      const len = u32();
      if (key === "lsct") r.section = buffer.readUInt32BE(p);
      if (key === "luni") {
        const chars = buffer.readUInt32BE(p);
        r.unicode = buffer.toString("utf16le", p + 4, p + 4 + chars * 2).replace(/(.)(.)/gs, "$1$2");
      }
      p += len + (len % 2);
    }
    assert.equal(p, extraEnd);
    records.push(r);
  }
  for (const r of records) {
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    r.planes = {};
    for (const ch of r.channels) {
      const start = p;
      const compression = u16();
      if (ch.length === 2) {
        p = start + ch.length;
        continue;
      }
      assert.equal(compression, 1);
      const counts = [];
      for (let y = 0; y < h; y += 1) counts.push(u16());
      const plane = new Uint8Array(w * h);
      for (let y = 0; y < h; y += 1) {
        plane.set(unpackBitsRow(buffer.subarray(p, p + counts[y]), w), y * w);
        p += counts[y];
      }
      assert.equal(p, start + ch.length);
      r.planes[ch.id] = plane;
    }
  }
  assert.ok(p <= infoEnd);
  return { sig, version, channels, width, height, depth, mode, records, sectionEnd, size: buffer.length };
}

test("PackBits round-trips literal and repeated rows", () => {
  const rows = [
    Uint8Array.from([1, 2, 3, 4, 5]),
    new Uint8Array(300).fill(9),
    Uint8Array.from([1, 1, 2, 3, 3, 3, 4, 5, 5, 6]),
    Uint8Array.from(Array.from({ length: 400 }, (_, i) => (i * 7) % 251)),
  ];
  for (const row of rows) {
    assert.deepEqual(unpackBitsRow(packBitsRow(row), row.length), row);
  }
});

test("the PSD has a valid header and the right size", () => {
  const { buffer, width, height, layers } = createPsdBuffer(sample());
  const psd = readPsd(buffer);
  assert.equal(psd.sig, "8BPS");
  assert.equal(psd.version, 1);
  assert.equal(psd.depth, 8);
  assert.equal(psd.mode, 3);
  assert.equal(psd.width, 64);
  assert.equal(psd.height, 48);
  assert.equal(width, 64);
  assert.equal(height, 48);
  assert.equal(layers, psd.records.length);
  assert.ok(psd.sectionEnd + 2 < psd.size);
  assert.equal(buffer.readUInt16BE(psd.sectionEnd), 1, "the merged image is RLE");
});

test("folders become nested layer groups, bottom to top", () => {
  const psd = readPsd(createPsdBuffer(sample()).buffer);
  const names = psd.records.map((r) => `${r.section ?? "-"}:${r.name}`);
  assert.deepEqual(names, [
    "-:Colour",
    "3:</Layer group>",
    "3:</Layer group>",
    "-:Ink",
    "1:Inner",
    "-:1",
    "1:Animation folder",
  ]);
});

test("layers keep opacity, visibility and clipping", () => {
  const psd = readPsd(createPsdBuffer(sample()).buffer);
  const byName = Object.fromEntries(psd.records.filter((r) => r.section !== 3).map((r) => [r.name, r]));
  assert.equal(byName.Ink.opacity, 128);
  assert.equal(byName.Ink.flags & 0x02, 0x02);
  assert.equal(byName["1"].flags & 0x02, 0);
  assert.equal(byName.Colour.clipping, 1);
  assert.equal(byName["1"].clipping, 0);
});

test("layer pixels match the application's own render, cropped to content", () => {
  const project = sample();
  const psd = readPsd(createPsdBuffer(project).buffer);
  for (const [name, index] of [["1", 1], ["Ink", 3], ["Colour", 4]]) {
    const record = psd.records.find((r) => r.name === name);
    const full = renderLayerRgba(project, project.layers[index], 1);
    const w = record.right - record.left;
    const h = record.bottom - record.top;
    assert.ok(w > 0 && h > 0 && w <= 64 && h <= 48, name);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const at = ((y + record.top) * 64 + (x + record.left)) * 4;
        const k = y * w + x;
        assert.equal(record.planes[0][k], full[at], `${name} r`);
        assert.equal(record.planes[-1][k], full[at + 3], `${name} a`);
      }
    }
    // Nothing outside the crop has any alpha.
    let outside = 0;
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const inside = x >= record.left && x < record.right && y >= record.top && y < record.bottom;
        if (!inside && full[(y * 64 + x) * 4 + 3] > 0) outside += 1;
      }
    }
    assert.equal(outside, 0, name);
  }
});

test("an empty layer is written with empty bounds", () => {
  const project = createProject(32, 32);
  const { buffer } = createPsdBuffer(project);
  const psd = readPsd(buffer);
  assert.equal(psd.records.length, 1);
  assert.equal(psd.records[0].right - psd.records[0].left, 0);
});
