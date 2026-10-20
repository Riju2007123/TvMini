import { test } from "node:test";
import assert from "node:assert/strict";
import { createTvppBuffer, importTvppBytes, readTvpp, decodeTvppLayers } from "../public/core/tvpp.js";
import { createProject, normalizeProject } from "../public/core/model.js";

function sampleProject() {
  const project = createProject(64, 48);
  project.fps = 12;
  project.background = "#ffffff";

  // Top layer: red disc on frame 1 held 2, gap, blue square at 4 held 1.
  const top = project.layers[0];
  top.name = "Ink";
  top.opacity = 0.8;
  top.drawings = [
    {
      at: 1,
      hold: 2,
      strokes: [{ color: "#ff0000", width: 4, points: [[8, 8], [20, 20]] }],
    },
    {
      at: 4,
      hold: 1,
      strokes: [{ color: "#0000ff", width: 3, points: [[30, 30]] }],
    },
  ];

  // A hidden layer with a stroke on one frame.
  const hidden = normalizeProject({
    ...project,
    layers: [
      {
        ...top,
        visible: false,
        name: "Sketch",
        drawings: top.drawings,
      },
      {
        name: "BG",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "hold",
        drawings: [
          { at: 2, hold: 3, strokes: [{ color: "#00ff00", width: 2, points: [[12, 12]] }] },
        ],
      },
    ],
  });
  return hidden;
}

test("tvpp round trip keeps canvas, rate and layer structure", () => {
  const project = sampleProject();
  const buffer = createTvppBuffer(project);
  assert.ok(buffer.length > 1000);

  const parsed = readTvpp(buffer);
  assert.equal(parsed.width, 64);
  assert.equal(parsed.height, 48);
  assert.equal(parsed.fps, 12);
  assert.equal(parsed.layers.length, 2);

  const [sketch, bg] = parsed.layers;
  assert.equal(sketch.name, "Sketch");
  assert.equal(sketch.hidden, true);
  assert.equal(sketch.opacity, Math.round(0.8 * 255));
  // LRHD carries our top layer first (TVPaint layer 1 is topmost).
  assert.equal(bg.name, "BG");

  // LRHD first frame matches the layer's own range.
  assert.equal(sketch.start, 1);
  assert.equal(bg.start, 2);
});

test("tvpp round trip decodes frame kinds and exposures", () => {
  const project = sampleProject();
  const parsed = decodeTvppLayers(readTvpp(createTvppBuffer(project)));

  // Ink layer: 1..4 (frames 1,2 = drawing held, 3 = gap, 4 = blue square).
  const ink = parsed.layers[0];
  assert.equal(ink.decoded.length, 4);
  assert.equal(ink.decoded[0].kind, "full");
  assert.equal(ink.decoded[1].kind, "same"); // held exposure = repeat stub
  assert.equal(ink.decoded[2].kind, "empty");
  assert.equal(ink.decoded[3].kind, "full");

  // Background layer starts at 2 with a 3-frame exposure.
  const bg = parsed.layers[1];
  assert.equal(bg.decoded[0].kind, "full");
  assert.equal(bg.decoded[1].kind, "same");
  assert.equal(bg.decoded[2].kind, "same");
  assert.equal(bg.decoded.length, 3);
});

test("tvpp import rebuilds a valid project with correct exposure runs", () => {
  const project = sampleProject();
  const { project: rebuilt, warnings } = importTvppBytes(createTvppBuffer(project));
  assert.deepEqual(warnings, []);

  assert.equal(rebuilt.width, 64);
  assert.equal(rebuilt.height, 48);
  assert.equal(rebuilt.fps, 12);
  assert.equal(rebuilt.layers.length, 2);

  const ink = rebuilt.layers[0];
  assert.equal(ink.name, "Sketch");
  assert.equal(ink.visible, false);
  assert.equal(ink.drawings.length, 2);
  assert.equal(ink.drawings[0].at, 1);
  assert.equal(ink.drawings[0].hold, 2);
  assert.equal(ink.drawings[1].at, 4);
  assert.equal(ink.drawings[1].hold, 1);

  const bg = rebuilt.layers[1];
  assert.equal(bg.visible, true);
  assert.equal(bg.drawings[0].at, 2);
  assert.equal(bg.drawings[0].hold, 3);

  // Each drawing carries its raster base at canvas size.
  const image = ink.drawings[0].image;
  assert.ok(image);
  assert.equal(image.width, 64);
  assert.equal(image.height, 48);
  assert.ok(image.data.length > 100);
});

test("tvpp pixels survive the trip: opaque colours exact, background transparent", () => {
  const project = sampleProject();
  const parsed = decodeTvppLayers(readTvpp(createTvppBuffer(project)));
  const frame = parsed.layers[0].decoded[0].rgba;

  // The red stroke is fully opaque red where the disc was stamped.
  let red = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] === 255 && frame[i + 1] === 0 && frame[i + 2] === 0 && frame[i + 3] === 255) red += 1;
  }
  assert.ok(red > 50, `expected opaque red pixels, found ${red}`);

  // Empty background stays fully transparent.
  let transparent = 0;
  const bgFrame = parsed.layers[1].decoded[0].rgba;
  for (let i = 3; i < bgFrame.length; i += 4) {
    if (bgFrame[i] === 0) transparent += 1;
  }
  assert.ok(transparent > 40 * 48, "most of an imported frame reads as transparent");
});

test("empty layer yields no .tvpp layer, blank drawings become empty frames", () => {
  const project = createProject(32, 32);
  project.layers[0].drawings = [{ at: 1, hold: 2, strokes: [] }];
  const parsed = decodeTvppLayers(readTvpp(createTvppBuffer(project)));
  assert.equal(parsed.layers.length, 1);
  assert.deepEqual(parsed.layers[0].decoded, [
    { kind: "empty" },
    { kind: "empty" },
  ]);

  const imported = importTvppBytes(createTvppBuffer(project));
  assert.equal(imported.project.layers[0].drawings.length, 0);
});

test("garbage input is rejected with a clear error", () => {
  assert.throws(() => readTvpp(Buffer.alloc(30)), /not a \.tvpp file/);
  assert.throws(() => readTvpp(Buffer.alloc(2000, 3)), /\.tvpp has no FORM media|no nodes/);
});

test("colour fidelity: every stroke colour keeps its red/green/blue on import", () => {
  const project = createProject(40, 40);
  const stroke = { color: "#40c880", width: 6, points: [[10, 10], [30, 30]] };
  project.layers[0].drawings = [{ at: 1, hold: 1, strokes: [stroke] }];

  const parsed = decodeTvppLayers(readTvpp(createTvppBuffer(project)));
  const rgba = parsed.layers[0].decoded[0].rgba;

  // Premultiply + unpremultiply must return the original 8-bit colour for
  // fully opaque pixels.
  const seen = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] !== 255) continue;
    seen.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  }
  assert.ok(seen.has("64,200,128"), `expected the exact stroke colour, saw ${[...seen].join(" ")}`);
});
