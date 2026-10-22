import test from "node:test";
import assert from "node:assert/strict";

import { smoothRadius, smoothStroke } from "../public/core/smooth.js";

/** A wave, the way a hand draws one. */
function wave(amplitude = 40, wavelength = 150, from = 0, to = 380, steps = 60) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push([
      from + (to - from) * t,
      amplitude * Math.sin((2 * Math.PI * (to - from) * t) / wavelength),
    ]);
  }
  return points;
}

/** How far the points of a path are from the wave they follow. */
function errorFromWave(points) {
  let worst = 0;
  for (const point of points) {
    worst = Math.max(worst, Math.abs(point[1] - 40 * Math.sin((2 * Math.PI * point[0]) / 150)));
  }
  return worst;
}

/** How far the line wanders up and down, without the ends. */
function wander(points) {
  const inner = points.slice(2, -2).map((point) => point[1]);
  return Math.max(...inner) - Math.min(...inner);
}

test("the smoothing takes the tremble out of a line", () => {
  // A straight line with a tremble in it: a quick up and down every eight
  // pixels, the way a hand moves.
  const shaky = [];
  for (let x = 0; x <= 100; x += 2) {
    shaky.push([x, x % 8 === 0 ? 0 : 2]);
  }

  assert.ok(wander(shaky) > 1.5, "the line starts with a tremble in it");
  const smoothed = smoothStroke(shaky, smoothRadius(50));
  assert.ok(wander(smoothed) < 0.5, "the tremble is gone");
});

test("the smoothing keeps the shape of the line", () => {
  // This is what the pencil and the brush of Flash do: a wave is still a
  // wave, only the trembling of the hand is gone.
  const before = wave();
  const after = smoothStroke(before, smoothRadius(50));
  assert.equal(after.length, before.length);
  assert.ok(
    errorFromWave(after) < 1.5,
    `the wave is still a wave (${errorFromWave(after)})`,
  );
});

test("the smoothing does not change the points it is given", () => {
  const wave1 = wave();
  const copy = wave1.map((point) => [...point]);
  smoothStroke(wave1, smoothRadius(50));
  assert.deepEqual(wave1, copy);
});

test("the smoothing at zero leaves the line alone", () => {
  const shaky = [
    [0, 0],
    [10, 3],
    [20, 0],
    [30, 4],
  ];
  const smoothed = smoothStroke(shaky, smoothRadius(0));
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
  const smoothed = smoothStroke(shaky, smoothRadius(100));
  assert.deepEqual(smoothed[0], shaky[0]);
  assert.deepEqual(smoothed[smoothed.length - 1], shaky[shaky.length - 1]);
});

test("the reach of the smoothing grows with the setting", () => {
  assert.equal(smoothRadius(0), 0);
  assert.ok(smoothRadius(100) > smoothRadius(50));
  assert.ok(smoothRadius(50) > smoothRadius(10));
  // A setting that is not a number is no smoothing at all.
  assert.equal(smoothRadius("nonsense"), 0);
});

test("the pressure of a point is kept", () => {
  const points = [
    [0, 0, 0.2],
    [10, 0, 0.5],
    [20, 0, 0.9],
  ];
  const smoothed = smoothStroke(points, smoothRadius(50));
  assert.equal(smoothed.length, 3);
  assert.equal(smoothed[0][2], 0.2);
  assert.equal(smoothed[1][2], 0.5);
  assert.equal(smoothed[2][2], 0.9);
});
