import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/model.js";
import { encodeRgbaPng, renderLayerRgba } from "../src/png.js";
import { brushImageFromBytes, brushPngFromBytes } from "../public/core/brush.js";

/** A square PNG with a soft edge on the left, so the shape is obvious. */
function stampPng(size = 32) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const alpha = x < size / 2 ? 0 : 255;
      data[index] = 255;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = alpha;
    }
  }
  return encodeRgbaPng(size, size, data);
}

test("a brush image is found inside a Clip Studio Paint brush file", () => {
  const png = stampPng(16);
  assert.equal(brushPngFromBytes(png).equals(png), true);

  // A container that holds the picture, the way a .sut file does.
  const container = Buffer.concat([
    Buffer.from("SUTHEADER!!", "ascii"),
    Buffer.from([0, 1, 2, 3]),
    png,
    Buffer.from("trailing", "ascii"),
  ]);
  const found = brushPngFromBytes(container);
  assert.equal(found.equals(png), true);

  // A file with no picture in it is refused.
  assert.equal(brushPngFromBytes(Buffer.from("not a brush")), null);
  assert.equal(brushImageFromBytes(Buffer.from("not a brush")), null);
});

test("the brush image is the shape of the brush", () => {
  const png = stampPng(32);
  const project = createProject(200, 120, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    brush: { data: png.toString("base64") },
    strokes: [{ color: "#ff0000", width: 40, points: [[100, 60]] }],
  }];

  const pixels = renderLayerRgba(project, project.layers[0]);
  const at = (x, y) => pixels[(y * 200 + x) * 4 + 3];

  // The picture is half transparent, so half of the tip leaves nothing.
  assert.ok(at(88, 60) === 0, "the transparent half of the brush should not paint");
  assert.ok(at(112, 60) > 0, "the opaque half of the brush should paint");

  // The tip is a square, so it reaches the corner of its own box. A disc
  // would leave that corner empty.
  assert.ok(at(118, 42) > 0, "a square brush paints into its corner");
  assert.ok(at(100, 76) > 0, "a square brush paints to the edge");
});
