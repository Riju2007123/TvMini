import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createProject, normalizeProject, projectPath, ValidationError } from "../src/model.js";

test("createProject returns a valid empty project", () => {
  const project = createProject(320, 200, "#AABBCC");
  assert.equal(project.format, "tvmini");
  assert.equal(project.version, 1);
  assert.equal(project.width, 320);
  assert.equal(project.height, 200);
  assert.equal(project.background, "#aabbcc");
  assert.deepEqual(project.strokes, []);
});

test("createProject rejects out-of-range sizes", () => {
  assert.throws(() => createProject(0, 100), ValidationError);
  assert.throws(() => createProject(100, 5000), ValidationError);
});

test("normalizeProject keeps known fields and copies points", () => {
  const input = {
    format: "tvmini",
    version: 1,
    width: 100,
    height: 80,
    background: "#ffffff",
    strokes: [{ color: "#112233", width: 4, points: [[1, 2], [3, 4]] }],
    extra: "ignored",
  };
  const clean = normalizeProject(input);
  assert.equal(clean.extra, undefined);
  assert.deepEqual(clean.strokes[0].points, [[1, 2], [3, 4]]);
  assert.notEqual(clean.strokes[0].points, input.strokes[0].points);
});

test("normalizeProject rejects wrong format and version", () => {
  const base = createProject(100, 100);
  assert.throws(() => normalizeProject({ ...base, format: "tvpp" }), /not a tvmini project/);
  assert.throws(() => normalizeProject({ ...base, version: 2 }), /unsupported project version/);
});

test("normalizeProject rejects bad colours, points and widths", () => {
  const base = createProject(100, 100);
  assert.throws(() => normalizeProject({ ...base, background: "white" }), /#rrggbb/);
  assert.throws(
    () => normalizeProject({ ...base, strokes: [{ color: "#000000", width: 1, points: [] }] }),
    /at least one point/,
  );
  assert.throws(
    () => normalizeProject({ ...base, strokes: [{ color: "#000000", width: 0, points: [[0, 0]] }] }),
    /between 1 and 200/,
  );
});

test("normalizeProject accepts an optional pressure per point", () => {
  const base = createProject(100, 100);
  const clean = normalizeProject({
    ...base,
    strokes: [{ color: "#000000", width: 8, points: [[1, 2, 0.25], [3, 4]] }],
  });
  assert.deepEqual(clean.strokes[0].points, [[1, 2, 0.25], [3, 4]]);
});

test("normalizeProject rejects pressure outside 0..1", () => {
  const base = createProject(100, 100);
  const stroke = (pressure) => ({
    ...base,
    strokes: [{ color: "#000000", width: 8, points: [[0, 0, pressure]] }],
  });
  assert.throws(() => normalizeProject(stroke(1.5)), /between 0 and 1/);
  assert.throws(() => normalizeProject(stroke(-0.1)), /between 0 and 1/);
});

test("normalizeProject rejects a fourth coordinate", () => {
  const base = createProject(100, 100);
  assert.throws(
    () => normalizeProject({
      ...base,
      strokes: [{ color: "#000000", width: 8, points: [[0, 0, 0.5, 9]] }],
    }),
    /\[x, y, pressure\]/,
  );
});

test("normalizeProject keeps the eraser flag and rejects non-booleans", () => {
  const base = createProject(100, 100);
  const clean = normalizeProject({
    ...base,
    strokes: [
      { color: "#000000", width: 8, points: [[1, 1]], eraser: true },
      { color: "#000000", width: 8, points: [[2, 2]], eraser: false },
    ],
  });

  assert.equal(clean.strokes[0].eraser, true);
  assert.equal(clean.strokes[1].eraser, undefined);

  assert.throws(
    () => normalizeProject({
      ...base,
      strokes: [{ color: "#000000", width: 8, points: [[1, 1]], eraser: "yes" }],
    }),
    /must be a boolean/,
  );
});

test("projectPath appends the extension only when missing", () => {
  assert.equal(path.basename(projectPath("C:/tmp/demo")), "demo.tvmini");
  assert.equal(path.basename(projectPath("C:/tmp/demo.tvmini")), "demo.tvmini");
  assert.throws(() => projectPath("   "), ValidationError);
});
