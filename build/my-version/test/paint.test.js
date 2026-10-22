import { test } from "node:test";
import assert from "node:assert/strict";
import { createProject, normalizeProject, ValidationError } from "../public/core/model.js";
import { renderDrawingRgba, renderLayerRgba } from "../public/core/png.js";
import {
  blendStrokeOver,
  eraseStrokeFrom,
  floodFillRgba,
  parseHexColor,
  sampleEllipse,
  smoothPoint,
  strokeOutline,
} from "../public/core/paint.js";

/** First opaque pixel matching a colour, or null. */
function findPixel(rgba, width, height, hex) {
  const [r, g, b] = parseHexColor(hex);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (
        Math.abs(rgba[index] - r) <= 2 &&
        Math.abs(rgba[index + 1] - g) <= 2 &&
        Math.abs(rgba[index + 2] - b) <= 2 &&
        rgba[index + 3] === 255
      ) {
        return [x, y];
      }
    }
  }
  return null;
}

function countPixels(rgba, hex) {
  const [r, g, b] = parseHexColor(hex);
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs(rgba[i] - r) <= 2 &&
      Math.abs(rgba[i + 1] - g) <= 2 &&
      Math.abs(rgba[i + 2] - b) <= 2 &&
      rgba[i + 3] === 255
    ) {
      count += 1;
    }
  }
  return count;
}

function alphaAt(rgba, width, x, y) {
  return rgba[(y * width + x) * 4 + 3];
}

test("normalizeProject accepts shape, fill, opacity and blend fields on strokes", () => {
  const project = normalizeProject({
    ...createProject(16, 16),
    layers: [
      {
        name: "L",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [
          {
            at: 1,
            hold: 1,
            strokes: [
              { color: "#ff0000", width: 2, points: [[1, 1], [5, 5]], kind: "line" },
              { color: "#00ff00", width: 2, points: [[1, 1], [5, 5]], kind: "rect", opacity: 0.5 },
              { color: "#0000ff", width: 2, points: [[1, 1], [5, 5]], kind: "ellipse", blend: "screen" },
              { color: "#123456", width: 2, points: [[8, 8]], kind: "fill" },
              { color: "#000000", width: 2, points: [[2, 2], [3, 3], [4, 4]] },
            ],
          },
        ],
      },
    ],
  });
  const strokes = project.layers[0].drawings[0].strokes;
  assert.equal(strokes[0].kind, "line");
  assert.equal(strokes[1].opacity, 0.5);
  assert.equal(strokes[2].blend, "screen");
  assert.equal(strokes[3].kind, "fill");
  // Freehand strokes stay freehand, and full-opacity/normal strokes drop the field.
  assert.equal(strokes[4].kind, undefined);
  assert.equal(strokes[2].opacity, undefined);
  assert.equal(strokes[1].blend, undefined);
});

test("normalizeProject rejects unknown kinds, blends and erasing fills", () => {
  const base = () => ({
    ...createProject(16, 16),
    layers: [
      {
        name: "L",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [{ at: 1, hold: 1, strokes: [] }],
      },
    ],
  });

  const withStroke = (stroke) => {
    const project = base();
    project.layers[0].drawings[0].strokes = [stroke];
    return normalizeProject(project);
  };

  assert.throws(() => withStroke({ color: "#000000", width: 1, points: [[0, 0]], kind: "triangle" }), ValidationError);
  assert.throws(() => withStroke({ color: "#000000", width: 1, points: [[0, 0]], blend: "burn" }), ValidationError);
  assert.throws(
    () => withStroke({ color: "#000000", width: 1, points: [[0, 0]], kind: "fill", eraser: true }),
    ValidationError,
  );
  assert.throws(() => withStroke({ color: "#000000", width: 1, points: [[0, 0]], opacity: 5 }), ValidationError);
});

test("the Node renderer draws a straight line stroke between its two points", () => {
  const project = createProject(32, 32);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [{ color: "#ff0000", width: 2, points: [[4, 8], [24, 8]], kind: "line" }],
  });
  assert.ok(findPixel(rgba, 32, 32, "#ff0000"));
  assert.equal(alphaAt(rgba, 32, 4, 8), 255); // on the line
  assert.equal(alphaAt(rgba, 32, 4, 16), 0); // well below it
});

test("the Node renderer outlines a rectangle and leaves the middle empty", () => {
  const project = createProject(32, 32);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [{ color: "#00aa00", width: 2, points: [[6, 6], [24, 20]], kind: "rect" }],
  });
  assert.ok(findPixel(rgba, 32, 32, "#00aa00"));
  assert.equal(alphaAt(rgba, 32, 15, 13), 0); // inside the outline
});

test("the Node renderer outlines an ellipse with the centre empty", () => {
  const project = createProject(40, 40);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [{ color: "#0000ff", width: 2, points: [[6, 6], [34, 30]], kind: "ellipse" }],
  });
  // The sampled ring must paint along the horizontal major axis.
  assert.ok(findPixel(rgba, 40, 40, "#0000ff"));
  assert.equal(alphaAt(rgba, 40, 20, 18), 0); // centre
  assert.equal(alphaAt(rgba, 40, 20, 6), 255); // top of the ring
  assert.equal(alphaAt(rgba, 40, 20, 30), 255); // bottom of the ring
});

test("the Node renderer flood fills inside a shape without spilling out", () => {
  const project = createProject(40, 40);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [
      // A green ring (ellipse), then a yellow fill seeded in its centre.
      { color: "#008800", width: 6, points: [[4, 4], [36, 36]], kind: "ellipse" },
      { color: "#ffcc00", width: 1, points: [[20, 20]], kind: "fill" },
    ],
  });
  assert.ok(findPixel(rgba, 40, 40, "#ffcc00"), "fill colour appears");
  assert.equal(alphaAt(rgba, 40, 20, 20), 255); // the seed itself
  assert.equal(alphaAt(rgba, 40, 2, 2), 0); // outside the ring stays empty
  // The ring must survive as the boundary: green pixels still present.
  assert.ok(findPixel(rgba, 40, 40, "#008800"), "ring survives");
});

test("floodFillRgba respects the tolerance and canvas bounds", () => {
  const width = 6;
  const height = 4;
  const data = new Uint8Array(width * height * 4);
  // Two shades of grey: 100 and 108 (within tolerance 32), a 200 block, a gap column.
  const paint = (x, y, value) => {
    const index = (y * width + x) * 4;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 3; x += 1) paint(x, y, x === 0 ? 100 : 108);
    paint(3, y, 200);
  }

  const ok = floodFillRgba(data, width, height, 1, 1, [255, 0, 0], 32);
  assert.equal(ok, true);
  // Columns 0-2 (all within tolerance of each other) turn red.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      assert.equal(alphaAt(data, width, x, y), 255);
      const index = (y * width + x) * 4;
      assert.equal(data[index], 255); // red channel
    }
  }
  // Column 3 (grey 200, beyond tolerance) is untouched.
  const boundary = (y) => data[(y * width + 3) * 4];
  assert.equal(boundary(0), 200);

  // Out-of-bounds seeds are a no-op.
  assert.equal(floodFillRgba(data, width, height, -1, 0, [0, 0, 0]), false);
  assert.equal(floodFillRgba(data, width, height, width, 0, [0, 0, 0]), false);
});

test("blendStrokeOver matches canvas blend semantics for multiply and screen", () => {
  const blend = (dst, src, opacity, mode) => {
    const dstCopy = Uint8Array.from(dst);
    const mask = new Uint8Array(dst.length);
    mask[0] = src[0];
    mask[1] = src[1];
    mask[2] = src[2];
    mask[3] = 255;
    blendStrokeOver(dstCopy, mask, opacity, mode);
    return dstCopy;
  };

  // Red multiply over blue (opaque): the canvas blends to black.
  const overBlue = blend([0, 0, 255, 255], [255, 0, 0], 1, "multiply");
  assert.deepEqual([...overBlue.slice(0, 4)], [0, 0, 0, 255]);

  // Red screen over blue: the canvas blends to magenta.
  const screenBlue = blend([0, 0, 255, 255], [255, 0, 0], 1, "screen");
  assert.deepEqual([...screenBlue.slice(0, 4)], [255, 0, 255, 255]);

  // Half-transparent red over transparent stays half-transparent red.
  const overNothing = blend([0, 0, 0, 0], [255, 0, 0], 0.5, "normal");
  assert.deepEqual([...overNothing.slice(0, 4)], [255, 0, 0, 128]);

  // Half-transparent red over white: 50% pink.
  const overWhite = blend([255, 255, 255, 255], [255, 0, 0], 0.5, "normal");
  assert.deepEqual([...overWhite.slice(0, 4)], [255, 128, 128, 255]);
});

test("the Node renderer applies stroke opacity through the mask pass", () => {
  const project = createProject(16, 16);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [
      { color: "#ff0000", width: 6, points: [[8, 8]], opacity: 0.5 },
    ],
  });
  const index = (8 * 16 + 8) * 4;
  assert.equal(rgba[index + 3], 128); // half alpha
  assert.equal(rgba[index], 255); // pure red colour (not darkened)
  assert.equal(rgba[index + 1], 0);
  assert.equal(rgba[index + 2], 0);
});

test("the Node renderer multiplies a stroke against the paint under it", () => {
  const project = createProject(16, 16);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [
      { color: "#0000ff", width: 8, points: [[4, 8], [12, 8]] },
      { color: "#ffff00", width: 8, points: [[8, 8]], blend: "multiply" },
    ],
  });
  const index = (8 * 16 + 8) * 4;
  // Multiply is subtractive: yellow over blue gives black, still fully opaque.
  assert.equal(rgba[index], 0);
  assert.equal(rgba[index + 1], 0);
  assert.equal(rgba[index + 2], 0);
  assert.equal(rgba[index + 3], 255);
});

test("the Node renderer screens a stroke against the paint under it", () => {
  const project = createProject(16, 16);
  const rgba = renderDrawingRgba(project, {
    at: 1,
    hold: 1,
    strokes: [
      { color: "#0000ff", width: 8, points: [[4, 8], [12, 8]] },
      { color: "#ffff00", width: 8, points: [[8, 8]], blend: "screen" },
    ],
  });
  const index = (8 * 16 + 8) * 4;
  // Screen lightens: yellow over blue gives white.
  assert.ok(rgba[index] >= 253);
  assert.ok(rgba[index + 1] >= 253);
  assert.ok(rgba[index + 2] >= 253);
  assert.equal(rgba[index + 3], 255);
});

test("eraseStrokeFrom thins existing alpha by the masked fraction", () => {
  const dst = new Uint8Array(16);
  dst[3] = 200;
  dst[11] = 255;
  const mask = new Uint8Array(16);
  mask[3] = 255; // one fully-masked pixel, one untouched
  eraseStrokeFrom(dst, mask, 0.5);
  assert.equal(dst[3], 100);
  assert.equal(dst[11], 255);
});

test("older projects without the new fields still render", () => {
  const project = createProject(16, 16);
  project.layers[0].drawings = [
    { at: 1, hold: 1, strokes: [{ color: "#123456", width: 3, points: [[2, 2], [10, 10]] }] },
  ];
  const rgba = renderLayerRgba(project, project.layers[0], 1);
  assert.ok(findPixel(rgba, 16, 16, "#123456"));
  assert.equal(rgba.length, 16 * 16 * 4);
});

test("smoothPoint eases a raw sample toward the running point", () => {
  // Level 0 keeps the raw point untouched.
  assert.deepEqual(smoothPoint([0, 0], [10, 20], 0), [10, 20]);

  // Level 1 moves half of the way toward the raw point.
  const eased = smoothPoint([0, 0], [30, 60], 1);
  assert.ok(Math.abs(eased[0] - 15) < 1e-9);
  assert.ok(Math.abs(eased[1] - 30) < 1e-9);

  // A higher level pulls less far, so the path stays calmer.
  const gentle = smoothPoint([0, 0], [30, 60], 9);
  assert.ok(gentle[0] < eased[0]);

  // Without a previous point there is nothing to ease toward.
  assert.deepEqual(smoothPoint(null, [5, 6], 5), [5, 6]);

  // Pressure passes through unchanged.
  const withPressure = smoothPoint([0, 0], [10, 10, 0.42], 3);
  assert.equal(withPressure.length, 3);
  assert.equal(withPressure[2], 0.42);
});

test("strokeOutline gives the two sides of a line whose width changes", () => {
  // A line along the x axis, thin at the start, thick in the middle.
  const points = [
    [0, 0],
    [10, 0],
    [20, 0],
  ];
  const radii = [1, 5, 1];
  const { left, right } = strokeOutline(points, radii);

  // The two sides are above and below the line, each of them as far from
  // the line as the width of the line is there.
  assert.deepEqual(left[1], [10, 5]);
  assert.deepEqual(right[1], [10, -5]);
  assert.deepEqual(left[0], [0, 1]);
  assert.deepEqual(right[2], [20, -1]);

  // A line that turns: the sides follow the turn, and the corner is
  // joined in the middle of the two directions.
  const turned = strokeOutline(
    [
      [0, 0],
      [10, 0],
      [10, 10],
    ],
    [2, 2, 2],
  );
  assert.ok(Math.abs(turned.left[1][0] - 8.586) < 0.01);
  assert.ok(Math.abs(turned.left[1][1] - 1.414) < 0.01);
  assert.deepEqual(turned.left[2], [8, 10]);
});

test("sampleEllipse builds a closed ring around the bounding box", () => {
  const ring = sampleEllipse(0, 0, 20, 10, 24);
  assert.equal(ring.length, 24);
  const first = ring[0];
  const last = ring[ring.length - 1];
  assert.notEqual(first[0], last[0]); // 24 evenly spaced points cannot repeat
  for (const [x, y] of ring) {
    const dx = (x - 10) / 10;
    const dy = (y - 5) / 5;
    // Every sample lies on (or a hair off) the ellipse equation.
    assert.ok(Math.abs(dx * dx + dy * dy - 1) < 0.01, `${x},${y} on the ring`);
  }
  assert.equal(sampleEllipse(5, 5, 5, 9), null); // zero width
});

test("a layer with no drawing paints nothing instead of failing", () => {
  // A layer can have no drawing at the frame that is being painted: an
  // empty layer, or a frame the layer does not cover. The `.clip` export
  // paints every layer, so this has to give an empty picture rather than
  // throw.
  const project = createProject(32, 24);
  project.layers[0].drawings = [];

  const rgba = renderLayerRgba(project, project.layers[0], 1);
  assert.equal(rgba.length, 32 * 24 * 4);
  assert.ok(rgba.every((value) => value === 0), "the picture should be empty");
});
