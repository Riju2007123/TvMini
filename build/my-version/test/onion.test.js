import test from "node:test";
import assert from "node:assert/strict";
import { onionTargets } from "../public/onion.js";

const layer = {
  drawings: [
    { at: 1, hold: 2, strokes: [] },
    { at: 3, hold: 1, strokes: [] },
    { at: 4, hold: 3, strokes: [] },
    { at: 8, hold: 1, strokes: [] },
  ],
};

test("onionTargets returns the neighbouring drawings, nearest first", () => {
  const targets = onionTargets(layer, 4, { before: 2, after: 1 });
  assert.deepEqual(
    targets.map((t) => [t.side, t.step, t.drawing.at]),
    [
      ["before", 1, 3],
      ["before", 2, 1],
      ["after", 1, 8],
    ],
  );
});

test("a held drawing counts once and the current drawing is excluded", () => {
  const targets = onionTargets(layer, 5, { before: 5, after: 5 });
  assert.deepEqual(
    targets.map((t) => t.drawing.at),
    [3, 1, 8],
  );
});

test("weights fade from 1 toward 1/count", () => {
  const targets = onionTargets(layer, 8, { before: 3, after: 0 });
  assert.deepEqual(
    targets.map((t) => t.weight),
    [1, 2 / 3, 1 / 3],
  );
});

test("an empty frame ghosts its neighbours on both sides", () => {
  const sparse = { drawings: [{ at: 1, hold: 1 }, { at: 10, hold: 1 }] };
  const targets = onionTargets(sparse, 5, { before: 1, after: 1 });
  assert.deepEqual(targets.map((t) => [t.side, t.drawing.at]), [
    ["before", 1],
    ["after", 10],
  ]);
});

test("counts are clamped and empty layers return nothing", () => {
  assert.deepEqual(onionTargets({ drawings: [] }, 1), []);
  assert.deepEqual(onionTargets(layer, 4, { before: -3, after: "x" }), []);
  assert.equal(onionTargets(layer, 8, { before: 99, after: 0 }).length, 3);
});
