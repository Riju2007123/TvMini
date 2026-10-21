import test from "node:test";
import assert from "node:assert/strict";
import { createGroup, createLayer, createProject } from "../src/model.js";
import { renderProject } from "../src/png.js";

/**
 * A project with a folder that holds a layer, and a layer of its own.
 *
 *   [0] Folder   (a folder, holds a layer)
 *   [1] Inside   (a picture)
 *   [2] Outside  (a picture)
 */
function folderProject() {
  const project = createProject(16, 16);
  const folder = createGroup("Folder");
  const inside = createLayer("Inside");
  const outside = createLayer("Outside");
  project.layers = [folder, inside, outside];
  folder.parent = -1;
  inside.parent = 0;
  outside.parent = -1;
  // A red picture on each layer, so the canvas says which one was painted.
  inside.drawings = [{ at: 1, hold: 1, strokes: [], image: redPicture() }];
  outside.drawings = [{ at: 1, hold: 1, strokes: [], image: bluePicture() }];
  return project;
}

/** A picture in one colour. */
function picture(r, g, b) {
  const data = new Uint8Array(16 * 16 * 3);
  for (let index = 0; index < data.length; index += 3) {
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
  }
  const png = encode(16, 16, data);
  return { data: png.toString("base64"), width: 16, height: 16 };
}

function redPicture() {
  return picture(255, 0, 0);
}

function bluePicture() {
  return picture(0, 0, 255);
}

// The encoder lives next to the renderer; it is imported here so the test
// does not depend on the order of the imports above.
import { encodePng as encode } from "../src/png.js";

test("a layer inside a hidden folder is not painted", () => {
  const project = folderProject();
  let canvas = renderProject(project, 1);
  assert.deepEqual([...canvas.data.slice(0, 3)], [255, 0, 0], "the layer inside the folder is painted");

  // Hiding the folder hides the layer inside it, the way Clip Studio Paint
  // shows it. The layer outside is painted instead.
  project.layers[0].visible = false;
  canvas = renderProject(project, 1);
  assert.deepEqual([...canvas.data.slice(0, 3)], [0, 0, 255]);
});

test("a layer inside a folder that is half transparent is painted half", () => {
  const project = folderProject();
  // Only the layer inside the folder is painted, so the canvas says how
  // strongly the folder's opacity counts.
  project.layers[2].visible = false;
  project.layers[0].opacity = 0.5;
  const canvas = renderProject(project, 1);
  const [red, green, blue] = canvas.data;
  // The red picture over the white paper, at half strength.
  assert.equal(red, 255);
  assert.ok(Math.abs(green - 127) <= 1, `green is ${green}`);
  assert.ok(Math.abs(blue - 127) <= 1, `blue is ${blue}`);
});
