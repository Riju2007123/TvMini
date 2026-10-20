import { test } from "node:test";
import assert from "node:assert/strict";
import { strokePathGroups } from "../public/core/paint.js";

/**
 * The width of a segment is the sum of the radii at its two ends, so a
 * stroke that tapers is a run of segments of different widths. Segments
 * of the same width are drawn together, as one path.
 */
test("a stroke of one width is one path", () => {
  const points = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const radii = [3, 3, 3, 3];
  const groups = strokePathGroups(points, radii);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].width, 6);
  assert.equal(groups[0].from, 0);
  assert.equal(groups[0].to, 3);
});

test("every segment is covered exactly once", () => {
  const points = [];
  const radii = [];
  for (let i = 0; i < 12; i += 1) {
    points.push([i * 5, i * 2]);
    radii.push(2 + (i % 3));
  }
  const groups = strokePathGroups(points, radii);

  // The groups must follow one another without a gap and without an
  // overlap, and together they must cover every segment.
  let expectedSegment = 0;
  for (const group of groups) {
    assert.equal(group.from, expectedSegment, "the group starts where the last one ended");
    assert.ok(group.to > group.from, "a group covers at least one segment");
    expectedSegment = group.to;
  }
  assert.equal(expectedSegment, points.length - 1, "every segment is covered");

  // The width of a group is the width of the first segment it covers.
  for (const group of groups) {
    assert.equal(group.width, Math.max(1, radii[group.from] + radii[group.from + 1]));
  }
});

test("segments of the same width next to each other are drawn together", () => {
  // Five points with the radii 1, 1, 1, 4, 4 give the segments the widths
  // 2, 2, 5 and 8. The two segments of width 2 are drawn together, and
  // the other two are on their own.
  const points = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  const radii = [1, 1, 1, 4, 4];
  const groups = strokePathGroups(points, radii);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0], { width: 2, from: 0, to: 2 });
  assert.deepEqual(groups[1], { width: 5, from: 2, to: 3 });
  assert.deepEqual(groups[2], { width: 8, from: 3, to: 4 });
});

test("a stroke of one point has no segments", () => {
  assert.deepEqual(strokePathGroups([[0, 0]], [3]), []);
});

test("a width is never below one", () => {
  const groups = strokePathGroups([[0, 0], [1, 0]], [0, 0]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].width, 1);
});
