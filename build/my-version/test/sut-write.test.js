import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/model.js";
import { encodeRgbaPng } from "../src/png.js";
import { writeSutBrush } from "../public/core/sut-write.js";
import { readSutBrush } from "../public/core/sut.js";
import { readTar, writeTar } from "../public/core/tar.js";

/** A square PNG, so the picture of a brush is easy to recognise. */
function stampPng(size = 16) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      data[index] = 255;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  return encodeRgbaPng(size, size, data);
}

test("a TAR archive keeps the files it is given", () => {
  const files = [
    { name: "catalog.zip", data: Buffer.from("first") },
    { name: "data/material_0.layer", data: Buffer.from("second") },
  ];
  const archive = writeTar(files);
  const read = readTar(archive);
  assert.equal(read.length, 2);
  assert.equal(read[0].name, "catalog.zip");
  assert.equal(read[0].data.toString(), "first");
  assert.equal(read[1].name, "data/material_0.layer");
  assert.equal(read[1].data.toString(), "second");
});

test("a Clip Studio Paint brush is written and read again", async () => {
  const png = stampPng(16);
  const bytes = await writeSutBrush({
    name: "TVMini brush",
    size: 24,
    opacity: 80,
    flow: 60,
    hardness: 50,
    texture: { data: png.toString("base64") },
  });

  assert.ok(bytes.length > 0, "the brush file has content");

  // The file is a SQLite database with the tables a brush is made of.
  const { DatabaseSync } = await import("node:sqlite");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const file = path.join(os.tmpdir(), `tvmini-sut-${process.pid}.sut`);
  await fs.writeFile(file, bytes);

  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    for (const name of ["Manager", "Node", "Variant", "MaterialFile"]) {
      assert.ok(tables.includes(name), `the file should have a ${name} table`);
    }
    const node = db.prepare("SELECT NodeName FROM Node").get();
    assert.equal(node.NodeName, "TVMini brush");
    const size = db.prepare("SELECT BrushSize FROM Variant WHERE VariantID = 1").get();
    assert.equal(size.BrushSize, 24);
    db.close();
  } finally {
    await fs.rm(file, { force: true });
  }

  // The reader of a brush finds the name, the size and the picture again.
  const brush = await readSutBrush(bytes);
  assert.equal(brush.name, "TVMini brush");
  assert.equal(brush.size, 24);
  assert.equal(brush.flow, 60);
  assert.equal(brush.hardness, 50);
  assert.equal(brush.texture.width, 16);
  assert.equal(brush.texture.height, 16);
});

test("a brush with no picture is still a brush", async () => {
  const bytes = await writeSutBrush({ name: "plain", size: 6 });
  const { DatabaseSync } = await import("node:sqlite");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const file = path.join(os.tmpdir(), `tvmini-sut-plain-${process.pid}.sut`);
  await fs.writeFile(file, bytes);

  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const materials = db.prepare("SELECT count(*) AS n FROM MaterialFile").get();
    assert.equal(materials.n, 0, "a brush with no picture has no material");
    const node = db.prepare("SELECT NodeName FROM Node").get();
    assert.equal(node.NodeName, "plain");
    db.close();
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("the material of a brush holds the picture of the tip", async () => {
  const png = stampPng(8);
  const bytes = await writeSutBrush({
    name: "with a tip",
    size: 10,
    texture: { data: png.toString("base64") },
  });

  const { DatabaseSync } = await import("node:sqlite");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const file = path.join(os.tmpdir(), `tvmini-sut-material-${process.pid}.sut`);
  await fs.writeFile(file, bytes);

  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT FileData FROM MaterialFile").get();
    db.close();

    const files = readTar(Buffer.from(row.FileData));
    const names = files.map((file) => file.name);
    assert.ok(names.includes("data/material_0.layer"), "the tip is in the material");
    assert.ok(names.includes("icedata/layerData.xml"), "the material says what it is");
    const tip = files.find((file) => file.name === "data/material_0.layer");
    assert.equal(tip.data.length, png.length);
    assert.equal(tip.data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  } finally {
    await fs.rm(file, { force: true });
  }
});

test("the project keeps the picture of a brush", () => {
  const png = stampPng(8);
  const project = createProject(100, 100, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    brush: { data: png.toString("base64") },
    strokes: [],
  }];
  assert.equal(project.layers[0].drawings[0].brush.data, png.toString("base64"));
});

test("the tip of a brush is found in the material of the brush", async () => {
  const png = stampPng(8);
  // The material of a brush is a TAR archive, and the tip of the brush is
  // the thumbnail in it.
  const material = writeTar([
    { name: "catalog.zip", data: png },
    { name: "info.zip", data: png },
    { name: "data/material_0.layer", data: Buffer.from("a picture that cannot be read") },
    { name: "thumbnail/thumbnail.png", data: png },
    {
      name: "icedata/layerData.xml",
      data: Buffer.from("<datalist key=\"systemtag\"><data>BrushPattern</data></datalist>"),
    },
  ]);

  const { DatabaseSync } = await import("node:sqlite");
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const file = path.join(os.tmpdir(), `tvmini-sut-tip-${process.pid}.sut`);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE Node (NodeName TEXT);" +
      "CREATE TABLE Variant (VariantID INTEGER, BrushSize REAL, BrushSizeUnit INTEGER," +
      " Opacity INTEGER, BrushFlow INTEGER, BrushHardness INTEGER, BrushThickness INTEGER," +
      " BrushInterval INTEGER, TextureScale2 REAL, TextureRotate REAL, TextureImage BLOB);" +
      "CREATE TABLE MaterialFile (_PW_ID INTEGER, InstallFolder INTEGER, OriginalPath TEXT," +
      " OldMaterial INTEGER, FileData BLOB, CatalogPath TEXT, MaterialUuid TEXT);",
  );
  db.prepare("INSERT INTO Node VALUES (?)").run("a brush of Clip Studio Paint");
  db.prepare(
    "INSERT INTO Variant (VariantID, BrushSize, BrushSizeUnit, Opacity, BrushFlow," +
      " BrushHardness, BrushThickness, BrushInterval, TextureScale2, TextureRotate)" +
      " VALUES (1, 42, 0, 77, 60, 50, 90, 10, 100, 0)",
  ).run();
  db.prepare("INSERT INTO MaterialFile VALUES (1, 0, 'path', 0, ?, 'path', '')").run(material);
  db.close();

  try {
    const brush = await readSutBrush(await fs.readFile(file));
    assert.equal(brush.name, "a brush of Clip Studio Paint");
    assert.equal(brush.texture.width, 8, "the tip of the brush should be found");
    assert.equal(brush.texture.height, 8);
    // The settings of the brush are kept, so that it does not lose them.
    assert.equal(brush.size, 42);
    assert.equal(brush.opacity, 77);
    assert.equal(brush.flow, 60);
    assert.equal(brush.hardness, 50);
    assert.equal(brush.thickness, 90);
  } finally {
    await fs.rm(file, { force: true });
  }
});
