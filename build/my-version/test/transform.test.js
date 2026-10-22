/**
 * The transform of a cell: where its picture sits, how big it is and how
 * far it is turned.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createProject, normalizeProject } from "../public/core/model.js";
import { renderDrawingRgba } from "../public/core/png.js";
import { readClipLayersFromBytes } from "../public/core/clip.js";
import { createClipBuffer } from "../src/clip-write.js";
import {
  IDENTITY_TRANSFORM,
  isPlain,
  pointToPicture,
  transformMatrix,
  transformOf,
  transformRgba,
} from "../public/core/transform.js";

/** A project with one cell that has a stroke in it. */
function projectWith(transform = null) {
  const project = createProject(200, 100);
  project.layers[0].drawings = [
    {
      at: 1,
      hold: 1,
      strokes: [{ color: "#ff0000", width: 6, points: [[20, 50], [40, 50]] }],
      ...(transform ? { transform } : {}),
    },
  ];
  return project;
}

/** The pixels of a colour in a picture. */
function pixelsOf(rgba, width, height, red) {
  const found = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (rgba[at + 3] > 0 && rgba[at] === red) found.push([x, y]);
    }
  }
  return found;
}

test("a cell without a transform is where it was drawn", () => {
  const project = projectWith();
  const rgba = renderDrawingRgba(project, project.layers[0].drawings[0]);
  const red = pixelsOf(rgba, 200, 100, 255);
  assert.ok(red.length > 0, "the stroke is in the picture");
  const left = Math.min(...red.map((point) => point[0]));
  assert.ok(left >= 15 && left <= 25, `the stroke starts at ${left}`);
});

test("a cell that is moved is drawn where it says", () => {
  const project = projectWith({ x: 100, y: 0, scale: 1, rotation: 0 });
  const rgba = renderDrawingRgba(project, project.layers[0].drawings[0]);
  const red = pixelsOf(rgba, 200, 100, 255);
  const left = Math.min(...red.map((point) => point[0]));
  assert.ok(left >= 115 && left <= 125, `the stroke starts at ${left}`);
});

test("a cell that is made bigger is drawn bigger", () => {
  const project = createProject(200, 100);
  project.layers[0].drawings = [
    {
      at: 1,
      hold: 1,
      strokes: [{ color: "#ff0000", width: 6, points: [[80, 50], [120, 50]] }],
      transform: { x: 0, y: 0, scale: 2, rotation: 0 },
    },
  ];
  const rgba = renderDrawingRgba(project, project.layers[0].drawings[0]);
  const red = pixelsOf(rgba, 200, 100, 255);
  const left = Math.min(...red.map((point) => point[0]));
  const right = Math.max(...red.map((point) => point[0]));
  // The stroke is 40 pixels long and 6 wide; twice as big is 80 and 12.
  assert.ok(right - left >= 60, `the stroke is ${right - left} pixels long`);
});

test("a cell that is turned is drawn turned", () => {
  const project = createProject(200, 100);
  project.layers[0].drawings = [
    {
      at: 1,
      hold: 1,
      strokes: [{ color: "#ff0000", width: 6, points: [[80, 50], [120, 50]] }],
      transform: { x: 0, y: 0, scale: 1, rotation: 90 },
    },
  ];
  const rgba = renderDrawingRgba(project, project.layers[0].drawings[0]);
  const red = pixelsOf(rgba, 200, 100, 255);
  const top = Math.min(...red.map((point) => point[1]));
  const bottom = Math.max(...red.map((point) => point[1]));
  // The stroke lies on one line; turned by a quarter, it lies on one column.
  assert.ok(bottom - top >= 10, `the stroke is ${bottom - top} pixels tall`);
});

test("the picture and the canvas agree on where a point is", () => {
  const transform = { x: 30, y: -20, scale: 1.5, rotation: 25 };
  const matrix = transformMatrix(transform, 200, 100);
  // A point of the picture goes through the matrix...
  const picture = { x: 60, y: 70 };
  const canvas = {
    x: matrix.a * picture.x + matrix.c * picture.y + matrix.e,
    y: matrix.b * picture.x + matrix.d * picture.y + matrix.f,
  };
  // ...and comes back to where it was.
  const back = pointToPicture(canvas, transform, 200, 100);
  assert.ok(Math.abs(back.x - picture.x) < 0.001, `x came back as ${back.x}`);
  assert.ok(Math.abs(back.y - picture.y) < 0.001, `y came back as ${back.y}`);
});

test("a transform that says nothing is left out", () => {
  assert.equal(isPlain(IDENTITY_TRANSFORM), true);
  assert.equal(isPlain({ x: 0, y: 0, scale: 1, rotation: 0 }), true);
  assert.equal(isPlain({ x: 0, y: 0, scale: 1, rotation: 0.5 }), false);
  assert.deepEqual(transformOf(null), IDENTITY_TRANSFORM);
  assert.deepEqual(transformOf({ transform: { x: 5 } }), { x: 5, y: 0, scale: 1, rotation: 0 });
});

test("a picture that is not moved is the picture itself", () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  rgba[0] = 200;
  assert.equal(transformRgba(rgba, 4, 4, IDENTITY_TRANSFORM), rgba);
});

test("a project keeps the transform of its cells", () => {
  const project = projectWith({ x: 12, y: -4, scale: 1.25, rotation: 30 });
  const clean = normalizeProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(clean.layers[0].drawings[0].transform, {
    x: 12,
    y: -4,
    scale: 1.25,
    rotation: 30,
  });
});

test("a transform that cannot be drawn is refused", () => {
  const project = projectWith({ x: 0, y: 0, scale: 0, rotation: 0 });
  assert.throws(
    () => normalizeProject(JSON.parse(JSON.stringify(project))),
    /scale must be more than 0/,
  );
});

test("a cell that is moved is moved in the written .clip too", async () => {
  const project = createProject(200, 100);
  project.fps = 24;
  project.layers[0].drawings = [
    {
      at: 1,
      hold: 1,
      strokes: [{ color: "#ff0000", width: 6, points: [[80, 50], [120, 50]] }],
      transform: { x: 60, y: 0, scale: 1, rotation: 0 },
    },
  ];

  const written = await createClipBuffer(project, { name: "moved", animation: true });
  const layers = await readClipLayersFromBytes(Buffer.from(written.buffer));
  const layer = layers.find((entry) => entry.pixels?.length);
  assert.ok(layer, "the written file has a layer with a picture");

  const red = pixelsOf(layer.pixels, layer.width, layer.height, 255);
  assert.ok(red.length > 0, "the stroke is in the picture");
  const left = Math.min(...red.map((point) => point[0]));
  // The stroke was drawn from 80 to 120; the cell is moved 60 pixels right.
  assert.ok(left >= 135 && left <= 145, `the stroke starts at ${left}`);
});
