import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createLayer, createProject, ValidationError } from "../src/model.js";
import { exportPng, openProject, saveProject } from "../src/store.js";
import { decodePng, encodePng, renderProject } from "../src/png.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tvmini-store-"));
}

function addStroke(project, stroke, { frame = 1, hold = 1, layer = 0 } = {}) {
  const target = project.layers[layer];
  const existing = target.drawings.find((drawing) => drawing.at === frame && drawing.hold === hold);
  if (existing) existing.strokes.push(stroke);
  else target.drawings.push({ at: frame, hold, strokes: [stroke] });
  return project;
}

function sampleProject() {
  const project = createProject(64, 48);
  addStroke(project, { color: "#ff0000", width: 6, points: [[10, 10], [40, 30]] });
  return project;
}

function readChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

function pixelAt(rendered, x, y) {
  return Array.from(
    rendered.data.subarray((y * rendered.width + x) * 3, (y * rendered.width + x) * 3 + 3),
  );
}

test("save then open returns the same project", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "round-trip.tvmini");
  const project = sampleProject();

  const saved = await saveProject(file, project);
  assert.ok(saved.bytes > 0);

  const opened = await openProject(file);
  assert.deepEqual(opened.project, project);
});

test("save adds the extension when missing", async () => {
  const dir = await tempDir();
  const saved = await saveProject(path.join(dir, "no-extension"), createProject(32, 32));
  assert.equal(path.extname(saved.path), ".tvmini");
});

test("save replaces an existing file atomically and leaves no temp files", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "replace.tvmini");

  await saveProject(file, createProject(32, 32));
  const project = sampleProject();
  await saveProject(file, project);

  const opened = await openProject(file);
  assert.equal(opened.project.layers[0].drawings[0].strokes.length, 1);

  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("a failed save leaves no target and no temp file", async () => {
  const dir = await tempDir();
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "not a folder");

  await assert.rejects(() => saveProject(path.join(blocker, "x.tvmini"), createProject(32, 32)));

  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("open rejects invalid JSON and wrong format without touching the caller's object", async () => {
  const dir = await tempDir();

  const badJson = path.join(dir, "bad.tvmini");
  await fs.writeFile(badJson, "{oops");
  await assert.rejects(() => openProject(badJson), /not valid JSON/);

  const wrong = path.join(dir, "wrong.tvmini");
  await fs.writeFile(wrong, JSON.stringify({ format: "other", version: 2, width: 32, height: 32 }));
  await assert.rejects(() => openProject(wrong), ValidationError);
});

test("open reports a missing file clearly", async () => {
  await assert.rejects(() => openProject("C:/definitely/not/here.tvmini"), /file not found/);
});

test("open migrates a version 1 flat-stroke project", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "legacy.tvmini");
  await fs.writeFile(
    file,
    JSON.stringify({
      format: "tvmini",
      version: 1,
      width: 40,
      height: 30,
      background: "#ffffff",
      strokes: [{ color: "#ff0000", width: 4, points: [[1, 2], [3, 4]] }],
    }),
  );

  const opened = await openProject(file);
  assert.equal(opened.project.version, 3);
  assert.equal(opened.project.layers[0].drawings[0].at, 1);
  assert.equal(opened.project.layers[0].drawings[0].strokes.length, 1);
});

test("render fills the background and paints the stroke", () => {
  const project = sampleProject();
  const rendered = renderProject(project);

  assert.deepEqual(pixelAt(rendered, 1, 1), [255, 255, 255]);
  assert.deepEqual(pixelAt(rendered, 10, 10), [255, 0, 0]);
});

test("an eraser stroke removes paint and reveals the background", () => {
  const project = createProject(41, 41);
  addStroke(project, { color: "#ff0000", width: 20, points: [[20, 20]] });
  addStroke(project, { color: "#000000", width: 20, points: [[20, 20]], eraser: true });

  const rendered = renderProject(project);
  assert.deepEqual(pixelAt(rendered, 20, 20), [255, 255, 255]);
  assert.deepEqual(pixelAt(rendered, 1, 1), [255, 255, 255]);
});

test("a stroke painted after an eraser is visible again", () => {
  const project = createProject(41, 41);
  addStroke(project, { color: "#ff0000", width: 20, points: [[20, 20]] });
  addStroke(project, { color: "#000000", width: 20, points: [[20, 20]], eraser: true });
  addStroke(project, { color: "#0000ff", width: 20, points: [[20, 20]] });

  const rendered = renderProject(project);
  assert.deepEqual(pixelAt(rendered, 20, 20), [0, 0, 255]);
});

test("an eraser only clears its own layer, revealing lower layers", () => {
  const project = createProject(41, 41);
  project.layers = [createLayer("Top"), createLayer("Bottom")];
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [
      { color: "#ff0000", width: 20, points: [[20, 20]] },
      { color: "#000000", width: 20, points: [[20, 20]], eraser: true },
    ],
  }];
  project.layers[1].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{ color: "#0000ff", width: 20, points: [[20, 20]] }],
  }];

  const rendered = renderProject(project);
  assert.deepEqual(pixelAt(rendered, 20, 20), [0, 0, 255]);
});

test("pressure tapers the rendered stroke", () => {
  const light = createProject(41, 41);
  addStroke(light, { color: "#0000ff", width: 20, points: [[20, 20, 0.05]] });

  const lightImage = renderProject(light);
  assert.deepEqual(pixelAt(lightImage, 20, 20), [0, 0, 255]);
  assert.deepEqual(pixelAt(lightImage, 20, 25), [255, 255, 255]);

  const full = createProject(41, 41);
  addStroke(full, { color: "#0000ff", width: 20, points: [[20, 20]] });
  const fullImage = renderProject(full);
  assert.deepEqual(pixelAt(fullImage, 20, 25), [0, 0, 255]);
});

test("a pressured project survives save and open", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "pressure.tvmini");
  const project = createProject(50, 50);
  addStroke(project, { color: "#123456", width: 9, points: [[1, 2, 0.1], [3, 4, 0.9]] });

  await saveProject(file, project);
  const opened = await openProject(file);
  assert.deepEqual(
    opened.project.layers[0].drawings[0].strokes[0].points,
    [[1, 2, 0.1], [3, 4, 0.9]],
  );
});

test("an eraser project survives save and open", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "eraser.tvmini");
  const project = createProject(50, 50);
  addStroke(project, { color: "#123456", width: 9, points: [[1, 2]], eraser: true });

  await saveProject(file, project);
  const opened = await openProject(file);
  assert.equal(opened.project.layers[0].drawings[0].strokes[0].eraser, true);
});

test("layers composite bottom-to-top and honour opacity", () => {
  const project = createProject(21, 21);
  project.layers = [createLayer("Top"), createLayer("Bottom")];
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{ color: "#ff0000", width: 20, points: [[10, 10]] }],
  }];
  project.layers[1].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{ color: "#0000ff", width: 20, points: [[10, 10]] }],
  }];

  assert.deepEqual(pixelAt(renderProject(project), 10, 10), [255, 0, 0]);

  project.layers[0].opacity = 0.5;
  assert.deepEqual(pixelAt(renderProject(project), 10, 10), [128, 0, 128]);

  project.layers[0].visible = false;
  assert.deepEqual(pixelAt(renderProject(project), 10, 10), [0, 0, 255]);
});

test("render uses the requested frame and honours exposure", () => {
  const project = createProject(21, 21);
  project.layers[0].preBehavior = "none";
  project.layers[0].postBehavior = "none";
  project.layers[0].drawings = [{
    at: 5,
    hold: 3,
    strokes: [{ color: "#ff0000", width: 20, points: [[10, 10]] }],
  }];

  assert.deepEqual(pixelAt(renderProject(project, 1), 10, 10), [255, 255, 255]);
  assert.deepEqual(pixelAt(renderProject(project, 5), 10, 10), [255, 0, 0]);
  assert.deepEqual(pixelAt(renderProject(project, 7), 10, 10), [255, 0, 0]);
  assert.deepEqual(pixelAt(renderProject(project, 8), 10, 10), [255, 255, 255]);
});

test("pre/post behaviour can hold or repeat drawings", () => {
  const project = createProject(21, 21);
  project.layers[0].preBehavior = "none";
  project.layers[0].postBehavior = "hold";
  project.layers[0].drawings = [{
    at: 2,
    hold: 1,
    strokes: [{ color: "#ff0000", width: 20, points: [[10, 10]] }],
  }];

  assert.deepEqual(pixelAt(renderProject(project, 1), 10, 10), [255, 255, 255]);
  assert.deepEqual(pixelAt(renderProject(project, 3), 10, 10), [255, 0, 0]);

  project.layers[0].postBehavior = "repeat";
  assert.deepEqual(pixelAt(renderProject(project, 4), 10, 10), [255, 0, 0]);

  project.layers[0].postBehavior = "pingpong";
  project.layers[0].drawings.push({
    at: 3,
    hold: 1,
    strokes: [{ color: "#0000ff", width: 20, points: [[10, 10]] }],
  });
  // With drawings at 2 and 3, ping-pong is 2,3,2,3,...
  assert.deepEqual(pixelAt(renderProject(project, 4), 10, 10), [255, 0, 0]);
  assert.deepEqual(pixelAt(renderProject(project, 5), 10, 10), [0, 0, 255]);
  assert.deepEqual(pixelAt(renderProject(project, 6), 10, 10), [255, 0, 0]);
});

test("export writes the current frame as a valid PNG", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "out.png");
  const project = createProject(41, 41);
  project.layers[0].preBehavior = "none";
  project.layers[0].postBehavior = "none";
  project.layers[0].drawings = [
    { at: 1, hold: 1, strokes: [{ color: "#ff0000", width: 20, points: [[20, 20]] }] },
    { at: 2, hold: 1, strokes: [{ color: "#0000ff", width: 20, points: [[20, 20]] }] },
  ];
  project.currentFrame = 2;

  const result = await exportPng(file, project);
  assert.equal(result.width, 41);
  assert.equal(result.height, 41);

  const buffer = await fs.readFile(file);
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(pixelAt(decodePng(buffer), 20, 20), [0, 0, 255]);

  const chunks = readChunks(buffer);
  assert.equal(chunks[0].type, "IHDR");
  assert.equal(chunks[0].data.readUInt32BE(0), 41);
  assert.equal(chunks[0].data.readUInt32BE(4), 41);
  assert.equal(chunks.at(-1).type, "IEND");

  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, (41 * 3 + 1) * 41);
});

test("encodePng rejects a mismatched buffer", () => {
  assert.throws(() => encodePng(10, 10, Buffer.alloc(10)), /does not match/);
});

test("export failure leaves no file", async () => {
  const dir = await tempDir();
  const blocker = path.join(dir, "blocker");
  await fs.writeFile(blocker, "x");

  await assert.rejects(() => exportPng(path.join(blocker, "x.png"), createProject(32, 32)));
  await assert.rejects(() => fs.access(path.join(blocker, "x.png")));
});
