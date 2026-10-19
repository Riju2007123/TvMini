import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "../server.js";
import { createProject } from "../src/model.js";

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
    const response = await post(app, "/api/save", {
      path: path.join(dir, "bad.tvmini"),
      project: { format: "tvmini", version: 1, width: 0, height: 10, background: "#fff", strokes: [] },
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

test("the UI is served from the public folder", async () => {
  await withServer(async (app) => {
    const response = await fetch(`${app.url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /TVMini/);
  });
});
