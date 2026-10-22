import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/model.js";
import { normalizeProject } from "../public/core/model.js";
import { encodeRgbaPng, renderLayerRgba } from "../src/png.js";

/** A drawing of one line across the middle of the canvas. */
function lineProject(brush) {
  const project = createProject(60, 60, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{
      color: "#000000",
      width: 12,
      points: [[8, 30], [52, 30]],
      brush,
    }],
  }];
  return normalizeProject(project);
}

/** The alpha of every pixel of the line. */
function alphas(project) {
  const pixels = renderLayerRgba(project, project.layers[0]);
  const out = [];
  for (let at = 3; at < pixels.length; at += 4) out.push(pixels[at]);
  return out;
}

/** How many pixels are painted, and how many of the pixels are full paint. */
function count(values) {
  let painted = 0;
  let full = 0;
  let part = 0;
  for (const alpha of values) {
    if (alpha > 0) painted += 1;
    if (alpha === 255) full += 1;
    if (alpha > 0 && alpha < 255) part += 1;
  }
  return { painted, full, part };
}

test("a brush paints solid paint", () => {
  const all = count(alphas(lineProject({ data: null })));

  assert.ok(all.full > 0, "a brush leaves solid paint");
  assert.ok(
    all.part < all.full / 4,
    "the paint is solid, and only the edge of it is soft",
  );
});

test("the edge of a stroke is soft, the way the browser draws it", () => {
  // A stroke that crosses the picture at an angle has an edge that falls
  // between the pixels. The export has to paint the share of the pixel the
  // tip covers, or the file holds steps where the screen shows a curve, and
  // Clip Studio Paint draws those steps as a staircase.
  const project = createProject(60, 60, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{
      color: "#000000",
      width: 5,
      points: [[8, 8], [52, 52]],
      brush: { data: null, spacing: 25 },
    }],
  }];
  const clean = normalizeProject(project);
  const pixels = renderLayerRgba(clean, clean.layers[0]);

  let part = 0;
  let full = 0;
  for (let at = 3; at < pixels.length; at += 4) {
    const alpha = pixels[at];
    if (alpha === 255) full += 1;
    if (alpha > 0 && alpha < 255) part += 1;
  }

  assert.ok(full > 0, "the stroke should be painted");
  assert.ok(part > 0, "the edge of the stroke should be soft, not a step");
  assert.ok(
    part < full,
    "only the edge of the stroke should be soft, the middle of it is solid",
  );
});

test("the paint of a stroke is as wide as the brush is", () => {
  // The width of the paint across a stroke: the alphas of a column through
  // it, added up, say how wide the stroke really is. A stroke that is fatter
  // than the brush is a stroke that was painted too many times over the same
  // pixels, and a thin stroke is where that shows first.
  const measure = (width, pressure) => {
    const project = createProject(60, 60, "#ffffff");
    project.layers[0].drawings = [{
      at: 1,
      hold: 1,
      strokes: [{
        color: "#000000",
        width,
        points: pressure === undefined
          ? [[8, 30], [52, 30]]
          : [[8, 30, pressure], [52, 30, pressure]],
      }],
    }];
    const clean = normalizeProject(project);
    const pixels = renderLayerRgba(clean, clean.layers[0]);
    const at = (x, y) => pixels[(y * 60 + x) * 4 + 3];
    let sum = 0;
    for (let y = 0; y < 60; y += 1) sum += at(30, y);
    return sum / 255;
  };

  const full = measure(12);
  assert.ok(
    Math.abs(full - 12) < 0.5,
    `a stroke of a 12px brush should be 12px of paint, it is ${full.toFixed(2)}px`,
  );

  // A light pen: the width follows the pressure, so the line is thinner.
  const light = measure(12, 0.3);
  const wanted = 12 * (0.2 + 0.8 * 0.3);
  assert.ok(
    Math.abs(light - wanted) < wanted * 0.25,
    `a light stroke should be about ${wanted.toFixed(2)}px of paint, it is ${light.toFixed(2)}px`,
  );
});

test("binarize leaves an edge that is paint or paper", () => {
  const soft = count(alphas(lineProject({ data: null, width: 12 })));
  const hard = count(alphas(lineProject({ data: null, width: 12, binarize: true })));

  assert.ok(soft.part > 0, "the edge of the tip is soft");
  assert.equal(hard.part, 0, "a binarized stroke has no half-covered pixel");
  assert.ok(hard.painted > 0, "a binarized stroke still paints");
  assert.ok(
    hard.painted < soft.painted,
    "the faint edge of the tip is dropped, so the line is a little narrower",
  );
});

test("binarize is kept with the stroke", () => {
  const clean = lineProject({ data: null, binarize: true }).layers[0].drawings[0].strokes[0].brush;
  assert.equal(clean.binarize, true);
  assert.equal(lineProject({ data: null }).layers[0].drawings[0].strokes[0].brush.binarize, undefined);
});

test("a brush keeps its settings through a save", () => {
  const brush = {
    data: null,
    size: 24,
    opacity: 80,
    spacing: 10,
  };
  const clean = lineProject(brush).layers[0].drawings[0].strokes[0].brush;

  assert.equal(clean.data, null, "a round brush has no picture");
  assert.equal(clean.size, 24);
  assert.equal(clean.opacity, 80);
  assert.equal(clean.spacing, 10);
});

test("a brush that says nothing is a plain round brush", () => {
  const clean = lineProject({ data: null }).layers[0].drawings[0].strokes[0].brush;
  assert.equal(clean.data, null);
  assert.equal(clean.spacing, undefined);
  assert.equal(clean.binarize, undefined);
});

test("the settings a brush no longer has are dropped", () => {
  // A project that was made with the settings of an older version of this
  // program still opens, and the settings that are gone are dropped with it.
  const clean = lineProject({
    data: null,
    flow: 40,
    hardness: 25,
    thickness: 60,
    grain: { data: null, density: 70 },
  }).layers[0].drawings[0].strokes[0].brush;

  assert.equal(clean.flow, undefined);
  assert.equal(clean.hardness, undefined);
  assert.equal(clean.thickness, undefined);
  assert.equal(clean.grain, undefined);
});
