import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../server.js";
import { createProject } from "../src/model.js";
import { encodePng } from "../src/png.js";
import { solid, writeClipFixture } from "./clip-fixture.js";

async function withServer(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvmini-api-"));
  const app = await startServer({ port: 0, recentFile: path.join(dir, "recent.json") });
  try {
    await run(app, dir);
  } finally {
    await app.close();
  }
}

function post(app, endpoint, body) {
  return fetch(`${app.url}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("state starts with an empty recent list", async () => {
  await withServer(async (app) => {
    const response = await fetch(`${app.url}/api/state`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.recent, []);
    assert.equal(typeof body.cwd, "string");
  });
});

test("save, then open, then recent", async () => {
  await withServer(async (app, dir) => {
    const target = path.join(dir, "project"); // no extension on purpose
    const project = createProject(80, 60);

    const saved = await post(app, "/api/save", { path: target, project });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(path.extname(savedBody.path), ".tvmini");
    assert.equal(savedBody.recent.length, 1);

    const opened = await post(app, "/api/open", { path: savedBody.path });
    assert.equal(opened.status, 200);
    const openedBody = await opened.json();
    assert.deepEqual(openedBody.project, project);

    const recent = await (await fetch(`${app.url}/api/recent`)).json();
    assert.equal(recent.entries.length, 1);
    assert.equal(recent.entries[0].path, savedBody.path);
  });
});

test("export writes a PNG and does not change recent", async () => {
  await withServer(async (app, dir) => {
    const png = path.join(dir, "frame.png");
    const response = await post(app, "/api/export", { path: png, project: createProject(40, 30) });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.width, 40);
    assert.equal(body.height, 30);

    const bytes = await fs.readFile(png);
    assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");

    const recent = await (await fetch(`${app.url}/api/recent`)).json();
    assert.equal(recent.entries.length, 0);
  });
});

test("invalid project is a 400 with a readable message", async () => {
  await withServer(async (app, dir) => {
    const bad = createProject(40, 30);
    bad.width = 0;
    const response = await post(app, "/api/save", {
      path: path.join(dir, "bad.tvmini"),
      project: bad,
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /width/);
  });
});

test("unknown endpoint is a 404", async () => {
  await withServer(async (app) => {
    const response = await fetch(`${app.url}/api/nope`);
    assert.equal(response.status, 404);
  });
});

test("import-clip turns a .clip preview into a project without touching recent", async () => {
  await withServer(async (app, dir) => {
    const clip = path.join(dir, "Animation15.clip");
    const png = encodePng(32, 24, solid(32, 24, [12, 34, 56]));
    await writeClipFixture(clip, { width: 32, height: 24, png });

    const response = await post(app, "/api/import-clip", { path: clip });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.name, "Animation15.clip");
    assert.equal(body.project.width, 32);
    assert.equal(body.project.height, 24);
    assert.equal(body.project.image.width, 32);
    assert.equal(Buffer.from(body.project.image.data, "base64").equals(png), true);
    assert.equal(body.project.layers.length, 1);
    assert.deepEqual(body.project.layers[0].drawings, []);

    const recent = await (await fetch(`${app.url}/api/recent`)).json();
    assert.equal(recent.entries.length, 0);
  });
});

test("import-clip rejects a non-clip file with 400", async () => {
  await withServer(async (app, dir) => {
    const other = path.join(dir, "notes.txt");
    await fs.writeFile(other, "hello");

    const response = await post(app, "/api/import-clip", { path: other });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /\.clip/);
  });
});

test("directory listing returns folders first and rejects traversal", async () => {
  await withServer(async (app, dir) => {
    await fs.mkdir(path.join(dir, "folder"));
    await fs.writeFile(path.join(dir, "file.txt"), "hello");

    const response = await fetch(`${app.url}/api/list?dir=${encodeURIComponent(dir)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.entries[0].name, "folder");
    assert.equal(body.entries[0].dir, true);

    const traversal = await fetch(`${app.url}/api/list?dir=${encodeURIComponent("../../")}`);
    assert.equal(traversal.status, 400);
  });
});

test("stat reports whether a save target already exists", async () => {
  await withServer(async (app, dir) => {
    const target = path.join(dir, "existing.tvmini");
    await fs.writeFile(target, "old");

    const exists = await (await fetch(`${app.url}/api/stat?path=${encodeURIComponent(target)}`)).json();
    assert.equal(exists.exists, true);
    assert.equal(exists.dir, false);
    assert.equal(exists.size, 3);

    const missing = await (
      await fetch(`${app.url}/api/stat?path=${encodeURIComponent(path.join(dir, "missing.tvmini"))}`)
    ).json();
    assert.equal(missing.exists, false);
  });
});

test("the UI is served from the public folder", async () => {
  await withServer(async (app) => {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /TVMini/);
  });
});
