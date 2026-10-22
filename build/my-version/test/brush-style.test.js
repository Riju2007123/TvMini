import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/model.js";
import { normalizeProject } from "../public/core/model.js";
import { encodeRgbaPng, renderLayerRgba } from "../src/png.js";
import { grainCoverage, grainMaskAt } from "../public/core/grain.js";

/** A picture of a grain: a chequerboard of paint and holes. */
function grainPng(size = 16) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      // The picture of a grain is black, and its alpha is the pattern. The
      // blocks are two pixels wide, so the pattern is not lost between two
      // pixels when it is sampled.
      data[at + 3] = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 255 : 0;
    }
  }
  return encodeRgbaPng(size, size, data);
}

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

test("the grain of the paper takes paint out of a stroke", () => {
  const plain = count(alphas(lineProject({ data: null })));
  const grained = count(alphas(lineProject({
    data: null,
    grain: { data: grainPng().toString("base64"), density: 100, scale: 100 },
  })));

  assert.ok(plain.full > 0, "a plain stroke should be solid");
  assert.ok(
    grained.full < plain.full * 0.75,
    "the holes of the grain should take paint out of the stroke",
  );
  assert.ok(grained.painted > 0, "the grain should not take the whole stroke away");
});

test("a grain at half strength leaves more paint than a grain at full strength", () => {
  const total = (project) => alphas(project).reduce((sum, alpha) => sum + alpha, 0);
  const full = total(lineProject({
    data: null,
    grain: { data: grainPng().toString("base64"), density: 100 },
  }));
  const half = total(lineProject({
    data: null,
    grain: { data: grainPng().toString("base64"), density: 50 },
  }));

  assert.ok(half > full, "a weaker grain should keep more of the stroke");
});

test("the grain belongs to the paper: it repeats, and its strength and turn are its settings", () => {
  // A picture of a grain that is a single row of ink.
  const picture = { width: 4, height: 4, alpha: Uint8Array.from([255, 128, 0, 64, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]) };
  const grain = { density: 100, scale: 100, rotate: 0, reverse: false };
  const inkAt = (x, y, settings) => grainMaskAt(picture, settings, x, y);

  // The same place of the paper holds the same ink, whatever was drawn before.
  assert.equal(inkAt(1.5, 0.5, grain), inkAt(1.5, 0.5, grain));
  // The picture repeats over the paper, once for every four pixels.
  assert.equal(inkAt(1.5, 0.5, grain), inkAt(5.5, 0.5, grain));
  // At a quarter of its size it repeats four times as often.
  assert.equal(inkAt(1.0, 0.5, { ...grain, scale: 25 }), inkAt(1.5, 0.5, { ...grain, scale: 25 }));
  // A grain at no strength leaves the paint alone; at full strength the
  // picture is the paint; turned over, it is the hole that paints.
  assert.equal(grainCoverage(0.25, { density: 0 }), 1);
  assert.equal(grainCoverage(0.25, { density: 1 }), 0.25);
  assert.equal(grainCoverage(0.25, { density: 1, reverse: true }), 0.75);
  assert.equal(grainCoverage(0.25, { density: 0.5 }), 0.625);
});

test("the flow of a brush says how much paint one dab leaves", () => {
  const all = count(alphas(lineProject({ data: null, flow: 100 })));
  const little = count(alphas(lineProject({ data: null, flow: 10 })));

  assert.equal(all.part, 0, "a brush at full flow leaves solid paint");
  assert.ok(little.part > 0, "a brush at low flow leaves paint that builds up");
  assert.ok(
    little.full < all.full,
    "a brush at low flow should leave less than a solid stroke",
  );
});

test("the hardness of a brush softens the edge of its tip", () => {
  const hard = count(alphas(lineProject({ data: null, hardness: 100, width: 12 })));
  const soft = count(alphas(lineProject({ data: null, hardness: 0, width: 12 })));

  assert.equal(hard.part, 0, "a hard brush has an edge, not a fade");
  assert.ok(soft.part > 0, "a soft brush fades out at its edge");
  assert.ok(soft.full < hard.full, "a soft brush has less paint at full strength");
});

test("binarize leaves an edge that is paint or paper", () => {
  const soft = count(alphas(lineProject({ data: null, hardness: 40, width: 12 })));
  const hard = count(alphas(lineProject({
    data: null,
    hardness: 40,
    width: 12,
    binarize: true,
  })));

  assert.ok(soft.part > 0, "a soft brush fades out at its edge");
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

test("the thickness of a brush makes its tip flat", () => {
  const round = count(alphas(lineProject({ data: null, thickness: 100 })));
  const flat = count(alphas(lineProject({ data: null, thickness: 30 })));

  assert.ok(
    flat.painted < round.painted * 0.6,
    "a flat tip should paint a thinner line across the stroke",
  );
});

test("a brush keeps its grain and its settings through a save", () => {
  const grain = grainPng();
  const brush = {
    data: null,
    flow: 40,
    hardness: 25,
    thickness: 60,
    spacing: 10,
    grain: {
      data: grain.toString("base64"),
      density: 70,
      scale: 150,
      rotate: 30,
      reverse: true,
    },
  };
  const clean = lineProject(brush).layers[0].drawings[0].strokes[0].brush;

  assert.equal(clean.data, null, "a round brush has no picture");
  assert.equal(clean.flow, 40);
  assert.equal(clean.hardness, 25);
  assert.equal(clean.thickness, 60);
  assert.equal(clean.spacing, 10);
  assert.equal(clean.grain.density, 70);
  assert.equal(clean.grain.scale, 150);
  assert.equal(clean.grain.rotate, 30);
  assert.equal(clean.grain.reverse, true);
  assert.equal(clean.grain.width, 16, "the size of the grain is read from the picture");
  assert.equal(clean.grain.height, 16);
});

test("a brush that says nothing is a hard round brush with no grain", () => {
  const clean = lineProject({ data: null }).layers[0].drawings[0].strokes[0].brush;
  assert.equal(clean.grain, undefined);
  assert.equal(clean.flow, undefined);
});
