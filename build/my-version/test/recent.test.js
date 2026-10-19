import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RecentStore } from "../src/recent.js";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tvmini-recent-"));
}

async function touch(dir, name) {
  const file = path.join(dir, name);
  await fs.writeFile(file, "x");
  return file;
}

test("recent keeps newest first and moves duplicates to the front", async () => {
  const dir = await tempDir();
  const store = new RecentStore(path.join(dir, "recent.json"));
  const a = await touch(dir, "a.tvmini");
  const b = await touch(dir, "b.tvmini");
  const c = await touch(dir, "c.tvmini");

  await store.add(a);
  await store.add(b);
  await store.add(c);
  assert.deepEqual(store.list().map((entry) => entry.name), ["c.tvmini", "b.tvmini", "a.tvmini"]);

  await store.add(a);
  assert.deepEqual(store.list().map((entry) => entry.name), ["a.tvmini", "c.tvmini", "b.tvmini"]);
});

test("recent de-duplicates case-insensitively on Windows", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only rule");
  const dir = await tempDir();
  const store = new RecentStore(path.join(dir, "recent.json"));
  const file = await touch(dir, "Case.tvmini");

  await store.add(file);
  await store.add(file.toUpperCase());
  assert.equal(store.list().length, 1);
});

test("recent caps the list", async () => {
  const dir = await tempDir();
  const store = new RecentStore(path.join(dir, "recent.json"), { max: 3 });

  for (const name of ["a", "b", "c", "d", "e"]) {
    await store.add(await touch(dir, `${name}.tvmini`));
  }

  assert.equal(store.list().length, 3);
  assert.deepEqual(store.list().map((entry) => entry.name), ["e.tvmini", "d.tvmini", "c.tvmini"]);
});

test("recent drops missing files on load and persists order", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "recent.json");
  const keep = await touch(dir, "keep.tvmini");
  const gone = path.join(dir, "gone.tvmini");

  await fs.writeFile(file, JSON.stringify({ version: 1, entries: [gone, keep] }));

  const store = new RecentStore(file);
  const list = await store.load();
  assert.deepEqual(list.map((entry) => entry.name), ["keep.tvmini"]);

  const again = new RecentStore(file);
  await again.load();
  assert.deepEqual(again.list().map((entry) => entry.name), ["keep.tvmini"]);
});

test("a corrupt recent file does not throw", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "recent.json");
  await fs.writeFile(file, "{not json");

  const store = new RecentStore(file);
  const list = await store.load();
  assert.deepEqual(list, []);
});

test("remove deletes only the requested entry", async () => {
  const dir = await tempDir();
  const store = new RecentStore(path.join(dir, "recent.json"));
  const a = await touch(dir, "a.tvmini");
  const b = await touch(dir, "b.tvmini");

  await store.add(a);
  await store.add(b);
  await store.remove(a);

  assert.deepEqual(store.list().map((entry) => entry.name), ["b.tvmini"]);
});
