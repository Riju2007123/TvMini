import test from "node:test";
import assert from "node:assert/strict";
import { strokeRadii } from "../public/core/paint.js";

test("the ends of a stroke are thin, the way the brush of Clip Studio Paint tapers", () => {
  // A straight line of ten points, all at the same pressure.
  const points = [];
  for (let index = 0; index < 10; index += 1) points.push([index * 10, 0, 1]);
  const stroke = { color: "#000000", width: 20, points };

  const plain = strokeRadii(stroke, 0);
  assert.equal(plain.length, 10);
  for (const radius of plain) assert.equal(radius, 10, "without a taper the width is the same");

  const tapered = strokeRadii(stroke, 0.2);
  assert.ok(tapered[0] < plain[0], "the first point is thinner");
  assert.ok(tapered[9] < plain[9], "the last point is thinner");
  assert.equal(tapered[5], plain[5], "the middle keeps its width");
  // The thin end is never thinner than the smallest fraction of the brush.
  assert.ok(tapered[0] >= plain[0] * 0.2);
});

test("a stroke with a pressure keeps its own width at every point", () => {
  const stroke = {
    color: "#000000",
    width: 20,
    // The hand pressed hard at the first point and lightly at the last.
    points: [[0, 0, 1], [10, 0, 0.2]],
  };
  const radii = strokeRadii(stroke, 0);
  assert.equal(radii[0], 10);
  assert.ok(radii[1] < radii[0]);
});
