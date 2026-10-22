import test from "node:test";
import assert from "node:assert/strict";

import { smoothStroke, smoothTolerance } from "../public/core/smooth.js";

/** How far a point is from the straight line between the ends of a path. */
function deviation(points) {
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return 0;
  let worst = 0;
  for (const point of points) {
    const d = Math.abs(dy * point[0] - dx * point[1] + last[0] * first[1] - last[1] * first[0]);
    worst = Math.max(worst, d / length);
  }
  return worst;
}

test("the smoothing takes the tremble out of a line", () => {
  // A straight line with a tremble in it.
  const shaky = [];
  for (let x = 0; x <= 100; x += 5) {
    shaky.push([x, x % 10 === 0 ? 0 : 2]);
  }

  const before = deviation(shaky);
  assert.ok(before > 1.5, "the line starts with a tremble in it");

  const smoothed = smoothStroke(shaky.map((point) => [...point]), smoothTolerance(100));
  assert.ok(deviation(smoothed) < 0.6, "the tremble is gone");
  assert.ok(smoothed.length < shaky.length, "the points that bend nothing are taken away");
});

test("the smoothing keeps the corners of the line", () => {
  // A corner: the middle point is far from the line through its neighbours.
  const corner = [
    [0, 0],
    [50, 0],
    [50, 50],
  ];
  const smoothed = smoothStroke(corner.map((point) => [...point]), smoothTolerance(100));
  assert.equal(smoothed.length, 3);
  assert.deepEqual(smoothed[1], [50, 0]);
});

test("the smoothing at zero leaves the line alone", () => {
  const shaky = [
    [0, 0],
    [10, 3],
    [20, 0],
    [30, 4],
  ];
  const smoothed = smoothStroke(shaky.map((point) => [...point]), smoothTolerance(0));
  assert.equal(smoothed.length, shaky.length);
  assert.deepEqual(smoothed, shaky);
});

test("the smoothing keeps the first and the last point of the stroke", () => {
  const shaky = [
    [3, 7],
    [10, 0],
    [20, 4],
    [40, 1],
    [61, 9],
  ];
  const smoothed = smoothStroke(shaky.map((point) => [...point]), smoothTolerance(100));
  assert.deepEqual(smoothed[0], shaky[0]);
  assert.deepEqual(smoothed[smoothed.length - 1], shaky[shaky.length - 1]);
});

test("the tolerance of the smoothing grows with the setting", () => {
  assert.equal(smoothTolerance(0), 0);
  assert.ok(smoothTolerance(100) > smoothTolerance(50));
  assert.ok(smoothTolerance(50) > smoothTolerance(10));
  // A setting that is not a number is no smoothing at all.
  assert.equal(smoothTolerance("nonsense"), 0);
});

test("the pressure of a point is kept when the point is kept", () => {
  const points = [
    [0, 0, 0.2],
    [10, 0, 0.5],
    [20, 0, 0.9],
  ];
  const smoothed = smoothStroke(points, smoothTolerance(100));
  // The middle point bends nothing, so it is taken away; the points that
  // are left keep their own pressure.
  assert.equal(smoothed.length, 2);
  assert.equal(smoothed[0][2], 0.2);
  assert.equal(smoothed[1][2], 0.9);
});
