import test from "node:test";
import assert from "node:assert/strict";
import { createGroup, createLayer, createProject } from "../src/model.js";
import {
  ancestorsOf,
  blockSize,
  cellName,
  childrenOf,
  clipSourceOf,
  effectiveOpacity,
  frameOfCellName,
  insertLayer,
  isGroup,
  isInside,
  keyframes,
  layerDepth,
  layerIsVisible,
  layerTree,
  moveBlock,
  nextKeyframe,
  packLayers,
  previousKeyframe,
  removeLayers,
} from "../public/timeline.js";

function cell(at, name) {
  const drawing = { at, hold: 1, strokes: [] };
  if (name) drawing.name = name;
  return drawing;
}

/**
 * A project with a folder that holds two layers, one of which holds a
 * folder of its own.
 *
 *   [0] Group        (folder)
 *   [1] Cell 1
 *   [2] Cell 2
 *   [3] Inner        (folder)
 *   [4] Cell 3
 *   [5] Other
 */
function treeProject() {
  const project = createProject(100, 100);
  const group = createGroup("Group");
  const first = createLayer("Cell 1");
  const second = createLayer("Cell 2");
  const inner = createGroup("Inner");
  const third = createLayer("Cell 3");
  const other = createLayer("Other");
  project.layers = [group, first, second, inner, third, other];
  group.parent = -1;
  first.parent = 0;
  second.parent = 0;
  inner.parent = 0;
  third.parent = 3;
  other.parent = -1;
  return project;
}

test("a folder holds the layers that point at it", () => {
  const project = treeProject();
  assert.deepEqual(childrenOf(project, -1), [0, 5]);
  assert.deepEqual(childrenOf(project, 0), [1, 2, 3]);
  assert.deepEqual(childrenOf(project, 3), [4]);
});

test("the tree lists the folders and their layers depth first", () => {
  const project = treeProject();
  assert.deepEqual(layerTree(project), [0, 1, 2, 3, 4, 5]);
  assert.equal(layerDepth(project, 0), 0);
  assert.equal(layerDepth(project, 1), 1);
  assert.equal(layerDepth(project, 4), 2);
  assert.deepEqual(ancestorsOf(project, 4), [3, 0]);
  assert.equal(isInside(project, 0, 4), true);
  assert.equal(isInside(project, 3, 1), false);
});

test("a folder is painted with the opacity of every folder above it", () => {
  const project = treeProject();
  project.layers[0].opacity = 0.5;
  project.layers[3].opacity = 0.5;
  assert.equal(effectiveOpacity(project, 4), 0.25);
  assert.equal(effectiveOpacity(project, 1), 0.5);
  assert.equal(effectiveOpacity(project, 5), 1);
});

test("a hidden folder hides the layers inside it", () => {
  const project = treeProject();
  assert.equal(layerIsVisible(project, 4), true);
  project.layers[0].visible = false;
  assert.equal(layerIsVisible(project, 4), false);
  assert.equal(layerIsVisible(project, 5), true);
});

test("a clipped layer is cut by the layer below it", () => {
  const project = treeProject();
  assert.equal(clipSourceOf(project, 1), 2);
  // The folder in the way has no picture, so the layer inside it is used.
  assert.equal(clipSourceOf(project, 2), 4);
  assert.equal(clipSourceOf(project, 5), -1);
});

test("cells are named after the frame they sit on", () => {
  const layer = createLayer("Test");
  assert.equal(cellName(layer, 1), "1");
  layer.drawings.push(cell(1));
  assert.equal(cellName(layer, 1), "1a");
  layer.drawings.push(cell(1));
  assert.equal(cellName(layer, 1), "1b");
  assert.equal(cellName(layer, 2), "2");
});

test("a cell name says which frame it belongs to", () => {
  assert.equal(frameOfCellName("1"), 1);
  assert.equal(frameOfCellName("12a"), 12);
  assert.equal(frameOfCellName("2b"), 2);
  assert.equal(frameOfCellName("Layer 1"), null);
  assert.equal(frameOfCellName("705c4893bfbb6d9a18110327b416f0fc"), null);
});

test("the keys of the timeline are the frames a cell starts on", () => {
  const project = createProject(100, 100);
  project.layers[0].drawings.push(cell(1), cell(4), cell(9));
  project.camera = { keys: [{ frame: 6 }] };
  assert.deepEqual(keyframes(project), [1, 4, 6, 9]);
  assert.equal(previousKeyframe(project, 9), 6);
  assert.equal(nextKeyframe(project, 4), 6);
  assert.equal(previousKeyframe(project, 1), null);
  assert.equal(nextKeyframe(project, 9), null);
});

test("a folder and the layers inside it are one block", () => {
  const project = treeProject();
  assert.equal(blockSize(project, 0), 5);
  assert.equal(blockSize(project, 3), 2);
  assert.equal(blockSize(project, 5), 1);
});

test("putting a layer in the list keeps the folders with their layers", () => {
  const project = treeProject();
  const layer = createLayer("New");
  insertLayer(project, 1, layer, 0);
  assert.equal(project.layers[1].name, "New");
  assert.equal(project.layers[1].parent, 0);
  // The folder is still at the top and the new layer is inside it.
  assert.equal(project.layers[0].type, "group");
  assert.deepEqual(childrenOf(project, 0), [1, 2, 3, 4]);
});

test("taking a layer out moves the numbers of the folders", () => {
  const project = treeProject();
  removeLayers(project, [1]);
  assert.deepEqual(project.layers.map((layer) => layer.name), ["Group", "Cell 2", "Inner", "Cell 3", "Other"]);
  assert.equal(project.layers[0].parent, -1);
  assert.equal(project.layers[1].parent, 0);
  assert.equal(project.layers[2].parent, 0);
  assert.equal(project.layers[3].parent, 2);
  assert.equal(project.layers[4].parent, -1);
});

test("moving a block of layers keeps the folders with their layers", () => {
  const project = treeProject();
  const indexOf = moveBlock(project, 0, 5, 1);
  assert.deepEqual(project.layers.map((layer) => layer.name), ["Other", "Group", "Cell 1", "Cell 2", "Inner", "Cell 3"]);
  assert.equal(indexOf.get(project.layers[1]), 1);
  assert.equal(project.layers[4].parent, 1);
  assert.equal(project.layers[5].parent, 4);
  assert.equal(project.layers[0].parent, -1);
});

test("the layers are put in order so a folder is followed by its layers", () => {
  const project = treeProject();
  // The folder sits at the end, away from the layers it holds.
  const byName = new Map(project.layers.map((layer) => [layer.name, layer]));
  const order = ["Other", "Cell 1", "Group", "Cell 2", "Inner", "Cell 3"];
  project.layers = order.map((name) => byName.get(name));
  // The numbers that say which folder holds a layer follow the new list.
  const position = new Map(project.layers.map((layer, index) => [layer, index]));
  const parents = new Map(project.layers.map((layer) => [layer, layer.parent]));
  for (const layer of project.layers) {
    const parent = parents.get(layer);
    layer.parent = parent === -1 ? -1 : position.get(byName.get(["Group", "Cell 1", "Cell 2", "Inner", "Cell 3", "Other"][parent]));
  }
  packLayers(project);
  assert.deepEqual(project.layers.map((layer) => layer.name), ["Other", "Group", "Cell 1", "Cell 2", "Inner", "Cell 3"]);
  assert.equal(project.layers[1].parent, -1);
  assert.equal(project.layers[2].parent, 1);
  assert.equal(project.layers[4].parent, 1);
  assert.equal(project.layers[5].parent, 4);
});

test("a layer can be taken out of the folder it is in", () => {
  const project = treeProject();
  // "Cell 2" sits in "Group" and comes out of it, the way the layers
  // panel takes a layer out of a folder.
  const index = 2;
  const layer = project.layers[index];
  const parent = layer.parent;
  const folder = project.layers[parent];
  const size = blockSize(project, index);

  const indexOf = moveBlock(project, index, size, parent);
  const moved = indexOf.get(layer);
  project.layers[moved].parent = folder.parent;

  assert.deepEqual(project.layers.map((item) => item.name), [
    "Cell 2", "Group", "Cell 1", "Inner", "Cell 3", "Other",
  ]);
  // The layer that came out is at the top level now, and the folder kept
  // the layers that were in it with it.
  assert.equal(project.layers[0].parent, -1);
  assert.equal(project.layers[1].parent, -1);
  assert.equal(project.layers[2].parent, 1);
  assert.equal(project.layers[3].parent, 1);
  assert.equal(project.layers[4].parent, 3);
  assert.equal(project.layers[5].parent, -1);
  assert.deepEqual(childrenOf(project, -1), [0, 1, 5]);
  assert.deepEqual(childrenOf(project, 1), [2, 3]);
  assert.deepEqual(layerTree(project), [0, 1, 2, 3, 4, 5]);
});

test("a folder that is taken out carries the layers it holds", () => {
  const project = treeProject();
  // "Inner" is a folder inside "Group", and it comes out with "Cell 3".
  // It lands above the folder it came out of, at the same level.
  const index = 3;
  const folder = project.layers[index];
  const parent = folder.parent;
  const outer = project.layers[parent];
  const size = blockSize(project, index);

  const indexOf = moveBlock(project, index, size, parent);
  const moved = indexOf.get(folder);
  project.layers[moved].parent = outer.parent;

  assert.deepEqual(project.layers.map((item) => item.name), [
    "Inner", "Cell 3", "Group", "Cell 1", "Cell 2", "Other",
  ]);
  assert.equal(project.layers[0].parent, -1);
  assert.equal(project.layers[1].parent, 0);
  assert.equal(project.layers[2].parent, -1);
  assert.equal(project.layers[3].parent, 2);
  assert.equal(project.layers[4].parent, 2);
  assert.equal(project.layers[5].parent, -1);
  assert.deepEqual(childrenOf(project, -1), [0, 2, 5]);
  assert.deepEqual(childrenOf(project, 0), [1]);
  assert.deepEqual(childrenOf(project, 2), [3, 4]);
  assert.deepEqual(layerTree(project), [0, 1, 2, 3, 4, 5]);
});

test("isGroup tells a folder from a drawing layer", () => {
  assert.equal(isGroup(createGroup("G")), true);
  assert.equal(isGroup(createLayer("L")), false);
});
