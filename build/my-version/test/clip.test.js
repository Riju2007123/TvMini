import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findClipDatabase, readClipPreview } from "../src/clip.js";
import { createProject, normalizeProject, ValidationError } from "../src/model.js";
import { decodePng, encodePng, renderProject } from "../src/png.js";
import { openProject, saveProject } from "../src/store.js";
import { solid, writeClipFixture } from "./clip-fixture.js";

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvmini-clip-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("decodePng round-trips the encoder", () => {
  const png = encodePng(4, 3, solid(4, 3, [10, 120, 200]));
  const image = decodePng(png);

  assert.equal(image.width, 4);
  assert.equal(image.height, 3);
  assert.equal(image.data.length, 4 * 3 * 4);
  assert.deepEqual([...image.data.subarray(0, 4)], [10, 120, 200, 255]);
});

test("renderProject draws the imported image behind strokes", () => {
  const project = createProject(32, 24);
  project.image = {
    data: encodePng(32, 24, solid(32, 24, [200, 0, 0])).toString("base64"),
    width: 32,
    height: 24,
  };
  project.strokes = [{ color: "#0000ff", width: 6, points: [[16, 12]] }];

  const { width, data } = renderProject(project);
  const pixel = (x, y) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

  assert.deepEqual(pixel(0, 0), [200, 0, 0]);
  assert.deepEqual(pixel(16, 12), [0, 0, 255]);
});

test("normalizeProject accepts an image that matches the canvas", () => {
  const project = createProject(32, 24);
  project.image = {
    data: encodePng(32, 24, solid(32, 24, [1, 2, 3])).toString("base64"),
    width: 32,
    height: 24,
  };

  const clean = normalizeProject(project);
  assert.equal(clean.image.width, 32);
  assert.equal(clean.image.height, 24);
  assert.equal(clean.image.data, project.image.data);
});

test("normalizeProject rejects a mismatched image and non-PNG data", () => {
  const bad = createProject(32, 24);
  bad.image = {
    data: encodePng(16, 16, solid(16, 16, [1, 2, 3])).toString("base64"),
    width: 16,
    height: 16,
  };
  assert.throws(() => normalizeProject(bad), ValidationError);

  const notPng = createProject(32, 24);
  notPng.image = { data: "aGVsbG8=", width: 32, height: 24 };
  assert.throws(() => normalizeProject(notPng), ValidationError);
});

test("readClipPreview extracts the embedded canvas preview", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "Animation15.clip");
    const png = encodePng(32, 24, solid(32, 24, [30, 100, 220]));
    await writeClipFixture(target, { width: 32, height: 24, png });

    const preview = await readClipPreview(target);
    assert.equal(preview.width, 32);
    assert.equal(preview.height, 24);
    assert.equal(preview.name, "Animation15.clip");
    assert.deepEqual(preview.png, png);
  });
});

test("readClipPreview rejects foreign files and damaged databases", async () => {
  await withTempDir(async (dir) => {
    const text = path.join(dir, "notes.clip");
    await fs.writeFile(text, "not a clip");
    await assert.rejects(() => readClipPreview(text), /not a Clip Studio/);

    const damaged = path.join(dir, "damaged.clip");
    await writeClipFixture(damaged, { png: Buffer.alloc(0), corrupt: true });
    await assert.rejects(() => readClipPreview(damaged), /cannot be read|no readable canvas preview/);

    await assert.rejects(() => readClipPreview(path.join(dir, "missing.clip")), /ENOENT/);
  });
});

test("findClipDatabase skips unrelated chunks", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "chunks.clip");
    const png = encodePng(32, 24, solid(32, 24, [0, 0, 0]));
    await writeClipFixture(target, { width: 32, height: 24, png });

    const data = await fs.readFile(target);
    const database = findClipDatabase(data);
    assert.equal(database.subarray(0, 15).toString("ascii"), "SQLite format 3");
  });
});

test("an imported image survives save and open", async () => {
  await withTempDir(async (dir) => {
    const project = createProject(32, 24);
    project.image = {
      data: encodePng(32, 24, solid(32, 24, [9, 8, 7])).toString("base64"),
      width: 32,
      height: 24,
    };

    const saved = await saveProject(path.join(dir, "imported.tvmini"), project);
    const opened = await openProject(saved.path);
    assert.deepEqual(opened.project.image, project.image);
  });
});
