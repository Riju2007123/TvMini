import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/model.js";
import { normalizeProject } from "../public/core/model.js";
import { encodeRgbaPng } from "../src/png.js";

/** A square PNG, so the picture of a brush is easy to recognise. */
function stampPng(size = 8) {
  const data = Buffer.alloc(size * size * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255;
    data[index + 1] = 0;
    data[index + 2] = 0;
    data[index + 3] = 255;
  }
  return encodeRgbaPng(size, size, data);
}

test("a stroke remembers the brush it was made with", () => {
  const png = stampPng(8);
  const project = createProject(100, 100, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    // The brush of the drawing is the one that is in the hand.
    brush: { data: png.toString("base64") },
    strokes: [
      // A stroke made with that brush keeps it.
      {
        color: "#ff0000",
        width: 10,
        points: [[10, 10]],
        brush: { data: png.toString("base64") },
      },
      // A stroke made without a picture says so, so that it is not given one
      // when another brush is picked.
      { color: "#ff0000", width: 10, points: [[20, 20]], brush: null },
    ],
  }];

  const clean = normalizeProject(project);
  const strokes = clean.layers[0].drawings[0].strokes;
  assert.equal("brush" in strokes[0], true, "the stroke should keep its brush");
  assert.equal(strokes[0].brush.data, png.toString("base64"));
  assert.equal("brush" in strokes[1], true, "the stroke should say it has no brush");
  assert.equal(strokes[1].brush, null);
});

test("a drawing that was made before strokes remembered their brush is put right", () => {
  const png = stampPng(8);
  const project = createProject(100, 100, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    brush: { data: png.toString("base64") },
    strokes: [{ color: "#ff0000", width: 10, points: [[10, 10]] }],
  }];

  const clean = normalizeProject(project);
  const strokes = clean.layers[0].drawings[0].strokes;
  // The stroke takes the brush of the drawing, so that changing the brush
  // from now on does not change it.
  assert.equal("brush" in strokes[0], true);
  assert.equal(strokes[0].brush.data, png.toString("base64"));
});
