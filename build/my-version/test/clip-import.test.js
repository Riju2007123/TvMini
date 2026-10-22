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

  // The chain of the document starts at the bottom, so the cells of the
  // animation folder follow their folder. The paper is not a layer: it is the
  // colour of the canvas, and the project keeps it as the background.
  // The cells of an animation folder are listed by frame, because that is how
  // a cell list reads: 1, 1a and then 2.
  assert.deepEqual(project.layers.map((layer) => layer.name), [
    "Animation folder",
    "1",
    "1a",
    "2",
  ]);
  const folder = project.layers[0];
  assert.equal(folder.type, "group");
  assert.deepEqual(
    project.layers.filter((layer) => layer.parent === 0).map((layer) => layer.name),
    ["1", "1a", "2"],
  );
});

test("the paper colour becomes the background of the project", () => {
  const tree = [
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Ink", { nextIndex: 4 }),
    node(4, "Paper", { kind: "paper", type: 1584, nextIndex: 0 }),
  ];

  const white = clipToProject(documentWith(tree), []);
  assert.equal(white.background, "#ffffff");

  const tinted = clipToProject({ ...documentWith(tree), paperColor: "#f0e0d0" }, []);
  assert.equal(tinted.background, "#f0e0d0");
  assert.equal(tinted.layers.length, 1, "the paper is not a layer");
});

test("the cells of an animation folder land on the frames they are named after", () => {  const document = documentWith([
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

test("a layer inside a cell lasts as long as the cell, not the whole animation", () => {
  // 17 frames, and the cell sits on frame 5. The layer inside the cell used to
  // get the length of the whole animation, so its drawing reached frame 21,
  // past the end of the timeline.
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
    }),
    node(4, "5", { kind: "folder", folder: true, firstChildIndex: 5, nextIndex: 0 }),
    node(5, "Layer 1", { nextIndex: 0 }),
  ], { endFrame: 16 });

  const project = clipToProject(document, []);
  const cell = project.layers.find((layer) => layer.name === "5");
  const inner = project.layers.find((layer) => layer.name === "Layer 1");

  assert.deepEqual(cell.drawings, [], "a cell folder holds no drawing of its own");
  assert.equal(inner.drawings[0].at, 5);
  assert.equal(inner.drawings[0].hold, 1, "the layer lasts as long as its cell");
  assert.ok(
    inner.drawings[0].at + inner.drawings[0].hold - 1 <= 17,
    "the drawing stays inside the timeline",
  );
});

test("cells follow the times of the track, not the order of their names", () => {
  // Three cells, keyed at 0, 4 and 8 ticks of a 30 fps document: frames 1, 3
  // and 5. The track ends on tick 12, which is frame 7: the first frame that
  // is not shown, so the last cell is held for frames 5 and 6.
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
    node(5, "2", { nextIndex: 6 }),
    node(6, "3", { nextIndex: 0 }),
  ], { frameRate: 30, endFrame: 16 });
  document.tracks = [{
    mainId: 5,
    kind: 2000,
    layerUuid: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    action2: {
      celKeys: [
        { time: 0, value: 0, tag: "1" },
        { time: 4, value: 1, tag: "2" },
        { time: 8, value: 2, tag: "3" },
      ],
      clipRange: { start: 0, end: 12, rate: 60 },
    },
  }];

  const project = clipToProject(document, []);
  const byName = (name) => project.layers.find((layer) => layer.name === name);
  assert.deepEqual(
    byName("1").drawings.map((drawing) => [drawing.at, drawing.hold]),
    [[1, 2]],
  );
  assert.deepEqual(
    byName("2").drawings.map((drawing) => [drawing.at, drawing.hold]),
    [[3, 2]],
  );
  assert.deepEqual(
    byName("3").drawings.map((drawing) => [drawing.at, drawing.hold]),
    [[5, 2]],
  );
});

test("a layer inside a cell follows the cell even when its name is a number", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Animation folder", {
      kind: "folder",
      folder: true,
      animationFolder: true,
      firstChildIndex: 4,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }),
    node(4, "1a", { kind: "folder", folder: true, firstChildIndex: 5, nextIndex: 0 }),
    node(5, "2", { nextIndex: 0 }),
  ], { frameRate: 30, endFrame: 16 });
  document.tracks = [{
    mainId: 5,
    kind: 2000,
    layerUuid: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    action2: {
      celKeys: [{ time: 0, value: 0, tag: "1a" }],
      clipRange: { start: 0, end: 8, rate: 60 },
    },
  }];

  const project = clipToProject(document, []);
  const inner = project.layers.find((layer) => layer.name === "2");
  // The layer is inside the cell "1a", which lasts frames 1 to 4. Its own
  // name, "2", must not move it to frame 2 or cut it down to one frame.
  assert.equal(inner.drawings[0].at, 1);
  assert.equal(inner.drawings[0].hold, 4);
  assert.equal(inner.drawings[0].name, "1a");
});

test("a layer outside an animation folder shows the whole time", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 3 }),
    node(3, "Ink", { nextIndex: 0 }),
  ]);

  const project = clipToProject(document, []);
  const layer = project.layers[0];
  assert.equal(layer.drawings[0].at, project.startFrame);
  // The timeline holds 20 frames, 1 to 20.
  assert.equal(layer.drawings[0].hold, 20);
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

test("the camera of a document becomes the camera of the project", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 7 }),
    node(7, "Paper", { kind: "paper", type: 1584 }),
  ]);
  // The numbers of the camera of Animation.clip: a frame of 1920 by 1080
  // around the point (954.6, 2570), shown at 73.9 percent.
  document.tracks = [{
    mainId: 42,
    kind: 2005,
    action2: {
      camera: {
        keys: [
          {
            time: 0,
            centreX: 960,
            centreY: 540,
            positionX: 954.637,
            positionY: 2570.084,
            rotation: 0,
            scale: 73.921,
          },
        ],
      },
    },
  }];

  const project = clipToProject(document, []);
  assert.equal(project.camera.keys.length, 1);
  const key = project.camera.keys[0];
  // The window the camera shows is the frame scaled by the zoom, with its
  // middle where the position says.
  assert.equal(key.frame, 1);
  assert.ok(Math.abs(key.x - 244.9954) < 0.01, `x is ${key.x}`);
  assert.ok(Math.abs(key.y - 2170.9106) < 0.01, `y is ${key.y}`);
  assert.ok(Math.abs(key.width - 1419.2832) < 0.01, `width is ${key.width}`);
  assert.ok(Math.abs(key.height - 798.3468) < 0.01, `height is ${key.height}`);
  assert.equal(key.rotation, 0);
});

test("a document without a camera has no camera in the project", () => {
  const document = documentWith([
    node(2, "", { kind: "root-folder", type: 256, folder: true, firstChildIndex: 7 }),
    node(7, "Paper", { kind: "paper", type: 1584 }),
  ]);
  const project = clipToProject(document, []);
  assert.equal(project.camera, null);
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
