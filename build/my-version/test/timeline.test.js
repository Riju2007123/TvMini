import test from "node:test";
import assert from "node:assert/strict";
import { createLayer, createProject } from "../src/model.js";
import {
  contentEnd,
  contentLength,
  deleteDrawing,
  drawingAt,
  drawingIndexAt,
  duplicateDrawing,
  exposureInfo,
  holdDrawing,
  insertDrawing,
  layerBounds,
  layerIsVisible,
  resolveDrawing,
  setExposure,
  shiftStartFrame,
  showLayer,
  timelineColumns,
  trimToFrame,
} from "../public/timeline.js";

function drawing(at, hold = 1, color = "#000000") {
  return { at, hold, strokes: [{ color, width: 2, points: [[1, 1]] }] };
}

function layerWith(drawings, overrides = {}) {
  return { ...createLayer("Test"), ...overrides, drawings };
}

test("drawing lookup finds heads and held cells", () => {
  const layer = layerWith([drawing(2, 3), drawing(7, 1)]);
  assert.equal(drawingIndexAt(layer, 1), -1);
  assert.equal(drawingIndexAt(layer, 2), 0);
  assert.equal(drawingIndexAt(layer, 4), 0);
  assert.equal(drawingIndexAt(layer, 5), -1);
  assert.equal(drawingAt(layer, 7).at, 7);
  assert.deepEqual(layerBounds(layer), { first: 2, last: 7 });
});

test("insertDrawing on an empty frame does not move other drawings", () => {
  const layer = layerWith([drawing(5, 1)]);
  const inserted = insertDrawing(layer, 2);
  assert.equal(inserted.at, 2);
  assert.deepEqual(layer.drawings.map((item) => item.at), [2, 5]);
});

test("insertDrawing at a head moves that drawing and later ones right", () => {
  const layer = layerWith([drawing(2, 2), drawing(6, 1)]);
  const inserted = insertDrawing(layer, 2);
  assert.equal(inserted.at, 2);
  assert.deepEqual(layer.drawings.map((item) => [item.at, item.hold]), [[2, 1], [3, 2], [7, 1]]);
});

test("insertDrawing inside an exposure splits it in three", () => {
  const layer = layerWith([drawing(1, 3), drawing(8, 1)]);
  const inserted = insertDrawing(layer, 2);
  assert.equal(inserted.at, 2);
  assert.deepEqual(layer.drawings.map((item) => [item.at, item.hold]), [[1, 1], [2, 1], [3, 2], [9, 1]]);
});

test("deleteDrawing closes the gap left by the removed exposure", () => {
  const layer = layerWith([drawing(1, 2), drawing(5, 1), drawing(8, 1)]);
  const removed = deleteDrawing(layer, 1);
  assert.equal(removed.at, 1);
  assert.deepEqual(layer.drawings.map((item) => item.at), [3, 6]);
  assert.equal(deleteDrawing(layer, 100), null);
});

test("duplicateDrawing inserts a copy after the exposure", () => {
  const layer = layerWith([drawing(1, 2), drawing(5, 1)]);
  const copy = duplicateDrawing(layer, 1);
  assert.equal(copy.at, 3);
  assert.equal(copy.hold, 2);
  assert.deepEqual(layer.drawings.map((item) => item.at), [1, 3, 7]);
  assert.notEqual(copy.strokes, layer.drawings[0].strokes);
});

test("setExposure moves later drawings by the same delta", () => {
  const layer = layerWith([drawing(1, 1), drawing(5, 1)]);
  setExposure(layer, 1, 3);
  assert.deepEqual(layer.drawings.map((item) => item.at), [1, 7]);

  setExposure(layer, 1, 2);
  assert.deepEqual(layer.drawings.map((item) => item.at), [1, 6]);

  assert.equal(setExposure(layer, 1, 0), null);
  assert.equal(setExposure(layer, 100, 2), null);
});

test("holdDrawing extends the exposure that owns the frame", () => {
  const layer = layerWith([drawing(1, 2)]);
  const held = holdDrawing(layer, 2);
  assert.equal(held.hold, 3);
  assert.equal(holdDrawing(layer, 50), null);
});

test("resolveDrawing applies pre and post behaviour", () => {
  const layer = layerWith([drawing(1), drawing(2), drawing(3)], {
    preBehavior: "none",
    postBehavior: "hold",
  });

  assert.equal(resolveDrawing(layer, 1).drawing.at, 1);
  assert.equal(resolveDrawing(layer, 4).drawing.at, 3);
  assert.equal(resolveDrawing(layer, 4).virtual, true);
  assert.equal(resolveDrawing(layer, 4).sourceFrame, 3);
  assert.equal(resolveDrawing(layer, 0), null);

  layer.postBehavior = "repeat";
  assert.equal(resolveDrawing(layer, 4).drawing.at, 1);
  assert.equal(resolveDrawing(layer, 5).drawing.at, 2);

  layer.postBehavior = "pingpong";
  assert.equal(resolveDrawing(layer, 4).drawing.at, 2);
  assert.equal(resolveDrawing(layer, 5).drawing.at, 1);

  layer.preBehavior = "repeat";
  assert.equal(resolveDrawing(layer, 0).drawing.at, 3);
});

test("exposureInfo labels head, hold, virtual and empty cells", () => {
  const layer = layerWith([drawing(2, 3)], {
    preBehavior: "hold",
    postBehavior: "hold",
  });

  assert.equal(exposureInfo(layer, 2).kind, "head");
  assert.equal(exposureInfo(layer, 3).kind, "hold");
  assert.equal(exposureInfo(layer, 3).remaining, 2);
  assert.equal(exposureInfo(layer, 1).kind, "virtual");
  assert.equal(exposureInfo(layer, 5).kind, "virtual");
  assert.equal(exposureInfo(layer, 4).kind, "hold");
  assert.equal(exposureInfo(layerWith([]), 1).kind, "empty");
});

test("contentEnd and timelineColumns include content and the playhead", () => {
  const project = createProject(20, 20);
  project.layers[0].drawings = [drawing(2, 2), drawing(8, 1)];
  assert.equal(contentEnd(project), 8);
  assert.equal(contentLength(project), 8);
  assert.equal(timelineColumns(project, 12), 12);

  // The default strip is long: three hundred frames of room to draw in.
  assert.equal(timelineColumns(project), 300);

  // A project that is longer than the default strip grows it.
  project.layers[0].drawings = [drawing(2, 2), drawing(400, 1)];
  assert.equal(timelineColumns(project), 404);

  project.layers[0].drawings = [drawing(2, 2), drawing(8, 1)];
  project.startFrame = 3;
  project.currentFrame = 3;
  // Drawings at 2 are before the start and do not add columns.
  assert.equal(contentEnd(project), 8);
  assert.equal(contentLength(project), 6);
});

test("shiftStartFrame moves drawings and the playhead together", () => {
  const project = createProject(20, 20);
  project.layers[0].drawings = [drawing(1, 1), drawing(4, 1)];
  project.currentFrame = 4;

  assert.equal(shiftStartFrame(project, 10), true);
  assert.equal(project.startFrame, 10);
  assert.equal(project.currentFrame, 13);
  assert.deepEqual(project.layers[0].drawings.map((item) => item.at), [10, 13]);
  assert.equal(shiftStartFrame(project, 0), false);
});

test("trimToFrame cuts the drawings short and takes the late ones away", () => {
  const project = createProject(20, 20);
  project.layers[0].drawings = [drawing(1, 2), drawing(5, 10), drawing(20, 1)];
  project.layers.push({ ...createLayer("Second"), drawings: [drawing(3, 1)] });

  // Two drawings are taken away: the one at 20 and nothing else.
  const removed = trimToFrame(project, 12);
  assert.equal(removed, 1);
  assert.deepEqual(project.layers[0].drawings.map((item) => [item.at, item.hold]), [
    [1, 2],
    [5, 8],
  ]);
  assert.deepEqual(project.layers[1].drawings.map((item) => item.at), [3]);
  assert.equal(contentEnd(project), 12);

  // A frame that is not a whole number changes nothing.
  assert.equal(trimToFrame(project, 12.5), 0);
  assert.equal(trimToFrame(project, 0), 0);
});

test("trimToFrame takes the camera keys past the last frame away", () => {
  const project = createProject(20, 20);
  project.camera = { keys: [{ frame: 2 }, { frame: 9 }, { frame: 30 }] };

  trimToFrame(project, 10);
  assert.deepEqual(project.camera.keys.map((key) => key.frame), [2, 9]);
  assert.equal(contentEnd(project), 9);
});

test("showLayer turns on the layer and the folders above it", () => {
  const project = createProject(20, 20);
  const folder = { ...createLayer("Folder"), type: "group", visible: false };
  const layer = { ...createLayer("Cell"), visible: true };
  project.layers = [folder, layer, { ...createLayer("Hidden"), visible: false }];
  layer.parent = 0;

  // A layer inside a hidden folder cannot be seen either.
  assert.equal(layerIsVisible(project, 1), false);
  assert.equal(showLayer(project, 1), true);
  assert.equal(folder.visible, true);
  assert.equal(layerIsVisible(project, 1), true);

  // A layer that is hidden itself is turned on as well.
  assert.equal(showLayer(project, 2), true);
  assert.equal(layerIsVisible(project, 2), true);

  // Nothing to turn on.
  assert.equal(showLayer(project, 1), false);
  assert.equal(showLayer(project, 9), false);
});
