import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createGroup,
  createLayer,
  createProject,
  normalizeProject,
  projectPath,
  ValidationError,
  VERSION,
} from "../src/model.js";

function projectWithDrawing(drawing, layerOverrides = {}) {
  const project = createProject(100, 100);
  project.layers = [
    {
      ...createLayer("Layer 1"),
      ...layerOverrides,
      drawings: [drawing],
    },
  ];
  return project;
}

function v1Project(strokes = []) {
  return {
    format: "tvmini",
    version: 1,
    width: 100,
    height: 80,
    background: "#ffffff",
    image: null,
    strokes,
  };
}

test("createProject returns a valid empty project", () => {
  const project = createProject(320, 200, "#AABBCC");
  assert.equal(project.format, "tvmini");
  assert.equal(project.version, VERSION);
  assert.equal(project.version, 3);
  assert.equal(project.width, 320);
  assert.equal(project.height, 200);
  assert.equal(project.background, "#aabbcc");
  assert.equal(project.fps, 12);
  assert.equal(project.startFrame, 1);
  assert.equal(project.currentLayer, 0);
  assert.equal(project.currentFrame, 1);
  assert.equal(project.loop, true);
  assert.equal(project.layers.length, 1);
  assert.equal(project.layers[0].name, "Layer 1");
  assert.equal(project.layers[0].type, "anim");
  assert.deepEqual(project.layers[0].drawings, []);
});

test("createProject rejects out-of-range sizes", () => {
  assert.throws(() => createProject(0, 100), ValidationError);
  assert.throws(() => createProject(100, 5000), ValidationError);
});

test("normalizeProject keeps known fields and copies points", () => {
  const input = {
    format: "tvmini",
    version: 2,
    width: 100,
    height: 80,
    background: "#ffffff",
    image: null,
    fps: 24,
    startFrame: 3,
    currentLayer: 0,
    currentFrame: 4,
    loop: false,
    layers: [
      {
        ...createLayer("Ink"),
        drawings: [
          {
            at: 3,
            hold: 2,
            strokes: [{ color: "#112233", width: 4, points: [[1, 2], [3, 4]] }],
          },
        ],
      },
    ],
    extra: "ignored",
  };

  const clean = normalizeProject(input);
  assert.equal(clean.extra, undefined);
  assert.equal(clean.fps, 24);
  assert.equal(clean.startFrame, 3);
  assert.equal(clean.currentFrame, 4);
  assert.equal(clean.loop, false);
  assert.deepEqual(clean.layers[0].drawings[0].strokes[0].points, [[1, 2], [3, 4]]);
  assert.notEqual(clean.layers[0].drawings[0].strokes[0].points, input.layers[0].drawings[0].strokes[0].points);
});

test("normalizeProject sorts drawings and rejects overlaps", () => {
  const project = createProject(100, 100);
  project.layers[0].drawings = [
    { at: 5, hold: 1, strokes: [] },
    { at: 1, hold: 2, strokes: [] },
  ];
  const clean = normalizeProject(project);
  assert.deepEqual(clean.layers[0].drawings.map((drawing) => drawing.at), [1, 5]);

  const overlap = createProject(100, 100);
  overlap.layers[0].drawings = [
    { at: 1, hold: 3, strokes: [] },
    { at: 3, hold: 1, strokes: [] },
  ];
  assert.throws(() => normalizeProject(overlap), /overlap/);
});

test("normalizeProject rejects wrong format and unsupported versions", () => {
  const base = createProject(100, 100);
  assert.throws(() => normalizeProject({ ...base, format: "tvpp" }), /not a tvmini project/);
  assert.throws(() => normalizeProject({ ...base, version: 9 }), /unsupported project version/);
});

test("version 2 projects are migrated to the folder aware schema", () => {
  const legacy = {
    format: "tvmini",
    version: 2,
    width: 100,
    height: 80,
    background: "#ffffff",
    image: null,
    fps: 24,
    startFrame: 1,
    currentLayer: 0,
    currentFrame: 1,
    loop: true,
    layers: [
      {
        name: "Ink",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [{ at: 1, hold: 1, strokes: [] }],
      },
    ],
  };

  const clean = normalizeProject(legacy);
  assert.equal(clean.version, VERSION);
  assert.equal(clean.layers[0].parent, -1);
  assert.equal(clean.layers[0].clip, false);
});

test("version 1 projects are migrated to one animation layer", () => {
  const clean = normalizeProject(
    v1Project([{ color: "#112233", width: 4, points: [[1, 2], [3, 4]] }]),
  );

  assert.equal(clean.version, VERSION);
  assert.equal(clean.layers.length, 1);
  assert.equal(clean.layers[0].name, "Layer 1");
  assert.equal(clean.layers[0].drawings.length, 1);
  assert.equal(clean.layers[0].drawings[0].at, 1);
  assert.equal(clean.layers[0].drawings[0].hold, 1);
  assert.deepEqual(clean.layers[0].drawings[0].strokes[0].points, [[1, 2], [3, 4]]);

  const empty = normalizeProject(v1Project());
  assert.deepEqual(empty.layers[0].drawings, []);
});

test("a folder holds the layers that point at it", () => {
  const project = createProject(100, 100);
  const folder = createGroup("Folder");
  const layer = createLayer("Inside");
  project.layers = [folder, layer];
  layer.parent = 0;

  const clean = normalizeProject(project);
  assert.equal(clean.layers[0].type, "group");
  assert.equal(clean.layers[1].parent, 0);
});

test("a layer may only sit in a folder that comes before it", () => {
  const project = createProject(100, 100);
  const layer = createLayer("Layer 1");
  const folder = createGroup("Folder");
  project.layers = [layer, folder];
  layer.parent = 1;
  assert.throws(() => normalizeProject(project), /parent must come before/);

  project.layers = [folder, createLayer("Other"), layer];
  layer.parent = 1;
  assert.throws(() => normalizeProject(project), /parent must be a folder/);
});

test("a folder cannot hold itself and the folders cannot loop", () => {
  const project = createProject(100, 100);
  const folder = createGroup("Folder");
  project.layers = [folder];
  folder.parent = 0;
  assert.throws(() => normalizeProject(project), /must not be the layer itself/);
});

test("a cell may carry a name", () => {
  const project = createProject(100, 100);
  project.layers[0].drawings = [
    { at: 1, hold: 1, strokes: [], name: "1a" },
    { at: 2, hold: 1, strokes: [], name: 7 },
  ];
  assert.throws(() => normalizeProject(project), /name must be text/);

  project.layers[0].drawings[1].name = "2";
  const clean = normalizeProject(project);
  assert.equal(clean.layers[0].drawings[0].name, "1a");
  assert.equal(clean.layers[0].drawings[1].name, "2");
});

test("normalizeProject rejects bad colours, points and widths", () => {  const base = createProject(100, 100);
  assert.throws(() => normalizeProject({ ...base, background: "white" }), /#rrggbb/);
  assert.throws(
    () => normalizeProject(projectWithDrawing({
      at: 1,
      hold: 1,
      strokes: [{ color: "#000000", width: 1, points: [] }],
    })),
    /at least one point/,
  );
  assert.throws(
    () => normalizeProject(projectWithDrawing({
      at: 1,
      hold: 1,
      strokes: [{ color: "#000000", width: 0, points: [[0, 0]] }],
    })),
    /between 1 and 200/,
  );
});

test("normalizeProject accepts an optional pressure per point", () => {
  const clean = normalizeProject(projectWithDrawing({
    at: 1,
    hold: 1,
    strokes: [{ color: "#000000", width: 8, points: [[1, 2, 0.25], [3, 4]] }],
  }));
  assert.deepEqual(clean.layers[0].drawings[0].strokes[0].points, [[1, 2, 0.25], [3, 4]]);
});

test("normalizeProject rejects pressure outside 0..1", () => {
  const stroke = (pressure) => projectWithDrawing({
    at: 1,
    hold: 1,
    strokes: [{ color: "#000000", width: 8, points: [[0, 0, pressure]] }],
  });
  assert.throws(() => normalizeProject(stroke(1.5)), /between 0 and 1/);
  assert.throws(() => normalizeProject(stroke(-0.1)), /between 0 and 1/);
});

test("normalizeProject rejects a fourth coordinate", () => {
  assert.throws(
    () => normalizeProject(projectWithDrawing({
      at: 1,
      hold: 1,
      strokes: [{ color: "#000000", width: 8, points: [[0, 0, 0.5, 9]] }],
    })),
    /\[x, y, pressure\]/,
  );
});

test("normalizeProject keeps the eraser flag and rejects non-booleans", () => {
  const clean = normalizeProject(projectWithDrawing({
    at: 1,
    hold: 1,
    strokes: [
      { color: "#000000", width: 8, points: [[1, 1]], eraser: true },
      { color: "#000000", width: 8, points: [[2, 2]], eraser: false },
    ],
  }));

  assert.equal(clean.layers[0].drawings[0].strokes[0].eraser, true);
  assert.equal(clean.layers[0].drawings[0].strokes[1].eraser, undefined);

  assert.throws(
    () => normalizeProject(projectWithDrawing({
      at: 1,
      hold: 1,
      strokes: [{ color: "#000000", width: 8, points: [[1, 1]], eraser: "yes" }],
    })),
    /must be a boolean/,
  );
});

test("normalizeProject validates layer fields and frame settings", () => {
  const base = createProject(100, 100);
  assert.throws(() => normalizeProject({ ...base, layers: [] }), /at least one layer/);
  assert.throws(
    () => normalizeProject({ ...base, layers: [{ ...createLayer(""), drawings: [] }] }),
    /name must not be empty/,
  );
  assert.throws(
    () => normalizeProject({ ...base, layers: [{ ...createLayer("A"), opacity: 2 }] }),
    /opacity/,
  );
  assert.throws(
    () => normalizeProject({ ...base, layers: [{ ...createLayer("A"), preBehavior: "bounce" }] }),
    /preBehavior/,
  );
  assert.throws(
    () => normalizeProject({ ...base, layers: [{ ...createLayer("A"), type: "folder" }] }),
    /type/,
  );
  assert.throws(
    () => normalizeProject({
      ...base,
      layers: [{ ...createLayer("A"), drawings: [{ at: 1, hold: 1, strokes: [] }] }],
      startFrame: 5,
      currentFrame: 5,
    }),
    /at or after startFrame/,
  );
  assert.throws(
    () => normalizeProject({ ...base, currentLayer: 2 }),
    /currentLayer/,
  );
  assert.throws(
    () => normalizeProject({ ...base, currentFrame: 0 }),
    /currentFrame/,
  );
});

test("projectPath appends the extension only when missing", () => {
  assert.equal(path.basename(projectPath("C:/tmp/demo")), "demo.tvmini");
  assert.equal(path.basename(projectPath("C:/tmp/demo.tvmini")), "demo.tvmini");
  assert.throws(() => projectPath("   "), ValidationError);
});
