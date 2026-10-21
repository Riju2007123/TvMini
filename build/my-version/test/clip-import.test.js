import test from "node:test";
import assert from "node:assert/strict";
import { clipToProject } from "../public/core/clip.js";

/**
 * A Clip Studio document, the way the reader describes it.
 *
 * The layers of a document are held in a chain: the first child of a folder
 * is the bottom layer and the chain that follows it goes up. The cells of an
 * animation folder are the layers inside it.
 */
function documentWith(tree, timeline = {}) {
  return {
    width: 200,
    height: 100,
    timeline: { frameRate: 24, startFrame: 0, endFrame: 20, currentFrame: 0, ...timeline },
    layerTree: tree,
  };
}

function node(id, name, extra = {}) {
  return {
    id,
    name,
    kind: "raster",
    type: 1,
    visible: true,
    locked: false,
    opacity: 1,
    folder: false,
    animationFolder: false,
    nextIndex: 0,
    firstChildIndex: 0,
    ...extra,
  };
}

test("the folders of a document become folders of the project", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 7 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
      nextIndex: 0,
    }),
    node(4, "1", { nextIndex: 5 }),
    node(5, "1a", { nextIndex: 6 }),
    node(6, "2", { nextIndex: 0 }),
    node(7, "Paper", { kind: "paper", type: 1584, nextIndex: 3 }),
  ]);

  const project = clipToProject(document, []);

  // The chain of the document starts at the bottom, so the paper is last.
  // The cells of an animation folder are listed by frame instead, because
  // that is how a cell list reads: 1, 1a and then 2.
  assert.deepEqual(project.layers.map((layer) => layer.name), [
    "Animation folder",
    "1",
    "1a",
    "2",
    "Paper",
  ]);
  const folder = project.layers[0];
  assert.equal(folder.type, "group");
  assert.deepEqual(
    project.layers.filter((layer) => layer.parent === 0).map((layer) => layer.name),
    ["1", "1a", "2"],
  );
});

test("the cells of an animation folder land on the frames they are named after", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
    }),
    node(4, "1", { nextIndex: 5 }),
    node(5, "1a", { nextIndex: 6 }),
    node(6, "2", { nextIndex: 7 }),
    node(7, "3", { nextIndex: 0 }),
  ]);

  const project = clipToProject(document, []);

  const cells = project.layers
    .filter((layer) => layer.parent === 0)
    .map((layer) => ({ name: layer.drawings[0].name, at: layer.drawings[0].at }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  assert.deepEqual(cells, [
    { name: "1", at: 1 },
    { name: "1a", at: 1 },
    { name: "2", at: 2 },
    { name: "3", at: 3 },
  ]);
  // A cell only shows on its own frame.
  for (const layer of project.layers) {
    if (layer.parent !== 0) continue;
    assert.equal(layer.preBehavior, "none");
    assert.equal(layer.postBehavior, "none");
    assert.equal(layer.drawings[0].hold, 1);
  }
});

test("a cell that holds other layers keeps the frame of the cell", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
    }),
    node(4, "1", { nextIndex: 5 }),
    node(5, "2a", { kind: "folder", folder: true, firstChildIndex: 6, nextIndex: 0 }),
    node(6, "Layer 1", { nextIndex: 7 }),
    node(7, "Layer 2", { nextIndex: 0 }),
  ]);

  const project = clipToProject(document, []);

  const cell = project.layers.find((layer) => layer.name === "2a");
  assert.equal(cell.type, "group");
  const inside = project.layers.filter((layer) => layer.parent === project.layers.indexOf(cell));
  assert.deepEqual(inside.map((layer) => layer.name), ["Layer 2", "Layer 1"]);
  for (const layer of inside) {
    assert.equal(layer.drawings[0].at, 2);
    assert.equal(layer.drawings[0].name, "2a");
  }
});

test("a layer outside an animation folder shows the whole time", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Ink", { nextIndex: 0 }),
  ]);

  const project = clipToProject(document, []);
  const layer = project.layers[0];
  assert.equal(layer.drawings[0].at, project.startFrame);
  assert.equal(layer.drawings[0].hold, 21);
  assert.equal(layer.drawings[0].name, undefined);
});

test("a cell that comes back later gets a drawing on every frame it shows", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }),
    node(4, "1", { nextIndex: 5 }),
    node(5, "2", { nextIndex: 0 }),
  ]);
  document.tracks = [{
    mainId: 5,
    kind: 2000,
    // The layer uuid is written with dashes, the track without them.
    layerUuid: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    action2: { celSequence: ["1", "2", "1"] },
  }];

  const project = clipToProject(document, []);
  const byName = (name) => project.layers.find((layer) => layer.name === name);

  // Cell 1 is on frames 1 and 3, cell 2 is on frame 2.
  assert.deepEqual(
    byName("1").drawings.map((drawing) => [drawing.at, drawing.hold]),
    [[1, 1], [3, 1]],
  );
  assert.deepEqual(
    byName("2").drawings.map((drawing) => [drawing.at, drawing.hold]),
    [[2, 1]],
  );
});

test("the frame of a cell comes from the track when the name disagrees", () => {
  // Clip Studio can put 3a after 4, where its name would say frame 3.
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }),
    node(4, "3a", { nextIndex: 0 }),
  ]);
  document.tracks = [{
    mainId: 5,
    kind: 2000,
    layerUuid: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    action2: { celSequence: ["1", "2", "3", "4", "3a"] },
  }];

  const project = clipToProject(document, []);
  const cell = project.layers.find((layer) => layer.name === "3a");
  // The name says frame 3; the track says frame 5, and the track wins.
  assert.equal(cell.drawings[0].at, 5);
  assert.equal(cell.drawings.length, 1);
});
