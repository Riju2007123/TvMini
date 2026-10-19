import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createProject, ValidationError } from "../src/model.js";
import { exportPng, openProject, saveProject } from "../src/store.js";
import { encodePng, renderProject } from "../src/png.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tvmini-store-"));
}

function sampleProject() {
  const project = createProject(64, 48);
  project.strokes.push({ color: "#ff0000", width: 6, points: [[10, 10], [40, 30]] });
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
  assert.equal(opened.project.strokes.length, 1);

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
  await fs.writeFile(wrong, JSON.stringify({ format: "other", version: 1, width: 32, height: 32 }));
  await assert.rejects(() => openProject(wrong), ValidationError);
});

test("open reports a missing file clearly", async () => {
  await assert.rejects(() => openProject("C:/definitely/not/here.tvmini"), /file not found/);
});

test("render fills the background and paints the stroke", () => {
  const project = sampleProject();
  const { width, height, data } = renderProject(project);

  const at = (x, y) => Array.from(data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));
  assert.deepEqual(at(1, 1), [255, 255, 255]);
  assert.deepEqual(at(10, 10), [255, 0, 0]);
});

test("pressure tapers the rendered stroke", () => {
  const light = createProject(41, 41);
  light.strokes.push({ color: "#0000ff", width: 20, points: [[20, 20, 0.05]] });

  const lightImage = renderProject(light);
  const atLight = (x, y) =>
    Array.from(lightImage.data.subarray((y * 41 + x) * 3, (y * 41 + x) * 3 + 3));

  assert.deepEqual(atLight(20, 20), [0, 0, 255]);
  assert.deepEqual(atLight(20, 25), [255, 255, 255]);

  const full = createProject(41, 41);
  full.strokes.push({ color: "#0000ff", width: 20, points: [[20, 20]] });
  const fullImage = renderProject(full);
  const atFull = (x, y) =>
    Array.from(fullImage.data.subarray((y * 41 + x) * 3, (y * 41 + x) * 3 + 3));

  assert.deepEqual(atFull(20, 25), [0, 0, 255]);
});

test("a pressured project survives save and open", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "pressure.tvmini");
  const project = createProject(50, 50);
  project.strokes.push({ color: "#123456", width: 9, points: [[1, 2, 0.1], [3, 4, 0.9]] });

  await saveProject(file, project);
  const opened = await openProject(file);
  assert.deepEqual(opened.project.strokes[0].points, [[1, 2, 0.1], [3, 4, 0.9]]);
});

test("export writes a valid PNG with the project size", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "out.png");
  const project = sampleProject();

  const result = await exportPng(file, project);
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);

  const buffer = await fs.readFile(file);
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const chunks = readChunks(buffer);
  assert.equal(chunks[0].type, "IHDR");
  assert.equal(chunks[0].data.readUInt32BE(0), 64);
  assert.equal(chunks[0].data.readUInt32BE(4), 48);
  assert.equal(chunks.at(-1).type, "IEND");

  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, (64 * 3 + 1) * 48);
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
