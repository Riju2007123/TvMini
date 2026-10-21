import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_RATIOS,
  cameraOfRatio,
  cameraWindow,
  paperPixels,
} from "../public/timeline.js";

test("a standard paper is measured in millimetres and dots an inch", () => {
  // A4 is 297 by 210 millimetres, so at 150 dots an inch it is 1754 by 1240 -
  // the size Clip Studio Paint writes into a document.
  assert.deepEqual(paperPixels("A4", 150), [1754, 1240]);
  assert.deepEqual(paperPixels("A4", 300), [3508, 2480]);
  assert.equal(paperPixels("Nothing", 150), null);
});

test("the camera of a shape sits in the middle of the paper", () => {
  const paper = { width: 1754, height: 1240 };
  const camera = cameraOfRatio(paper, "16:9");
  assert.equal(camera.width, 1491);
  assert.equal(camera.height, 839);
  // The frame is centred horizontally.
  assert.equal(camera.x, Math.round((paper.width - camera.width) / 2));
  assert.ok(Math.abs(camera.width / camera.height - 16 / 9) < 0.01);
});

test("a camera that is the same as the paper is the paper", () => {
  const paper = { width: 1754, height: 1240 };
  assert.deepEqual(cameraOfRatio(paper, "paper"), { x: 0, y: 0, width: 1754, height: 1240 });
});

test("a camera never reaches outside the paper", () => {
  const paper = { width: 800, height: 600 };
  const window = cameraWindow(paper, { width: 2000, height: 2000, y: 100 });
  assert.equal(window.width, 800);
  assert.equal(window.height, 600);
  assert.equal(window.x, 0);
  assert.equal(window.y, 0);
});

test("the camera keeps its place when the paper is smaller", () => {
  const window = cameraWindow(
    { width: 1000, height: 800 },
    { width: 400, height: 300, y: 250 },
  );
  assert.equal(window.x, 300);
  assert.equal(window.y, 250);
});

test("the shapes of the camera are the ones Clip Studio offers", () => {
  const names = CAMERA_RATIOS.map(([name]) => name);
  assert.deepEqual(names, ["4:3", "16:9", "9:16", "1:1", "2.39:1", "1.85:1", "1.66:1"]);
});
