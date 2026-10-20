import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findClipDatabase,
  readClipPreview,
  readClipDocument,
  readClipLayers,
} from "../src/clip.js";
import { createProject, normalizeProject, ValidationError } from "../src/model.js";
import { decodePng, encodePng, renderLayerRgba, renderProject } from "../src/png.js";
import { openProject, saveProject } from "../src/store.js";
import { createClipBuffer } from "../src/clip-write.js";
import {
  buildOffscreenAttribute,
  buildRasterPayload,
  solid,
  writeClipFixture,
} from "./clip-fixture.js";
import {
  parseClipContainer,
  readClipDocumentFromBytes,
  readClipLayersFromBytes,
} from "../public/core/clip.js";
import { parseActionDocument } from "../public/core/clip-animation.js";

/** The blank Clip Studio document the writer starts from. */
const TEMPLATE = new URL("../public/assets/clip-template.clip", import.meta.url);

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
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{ color: "#0000ff", width: 6, points: [[16, 12]] }],
  }];

  const { width, data } = renderProject(project);
  const pixel = (x, y) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

  assert.deepEqual(pixel(0, 0), [200, 0, 0]);
  assert.deepEqual(pixel(16, 12), [0, 0, 255]);
});

test("an eraser reveals the imported image underneath", () => {
  const project = createProject(32, 24);
  project.image = {
    data: encodePng(32, 24, solid(32, 24, [200, 0, 0])).toString("base64"),
    width: 32,
    height: 24,
  };
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [
      { color: "#0000ff", width: 20, points: [[16, 12]] },
      { color: "#000000", width: 20, points: [[16, 12]], eraser: true },
    ],
  }];

  const { width, data } = renderProject(project);
  const pixel = (x, y) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];

  assert.deepEqual(pixel(16, 12), [200, 0, 0]);
  assert.deepEqual(pixel(0, 0), [200, 0, 0]);
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

test("readClipDocument reports native container capabilities without claiming editable pixels", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "inspect.clip");
    const png = encodePng(32, 24, solid(32, 24, [12, 34, 56]));
    await writeClipFixture(target, { width: 32, height: 24, png });

    const document = await readClipDocument(target);
    assert.equal(document.name, "inspect.clip");
    assert.equal(document.format, "clip-studio-native-container");
    assert.equal(document.readOnly, true);
    assert.equal(document.preview.width, 32);
    assert.equal(document.capabilities.preview, true);
    assert.equal(document.capabilities.editableRasterPixels, false);
    assert.ok(document.tables.includes("CanvasPreview"));
    assert.ok(document.limitations.length > 0);
  });
});

test("readClipDocument reads the layer metadata and leaves the folder rows out", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "layers.clip");
    const png = encodePng(32, 24, solid(32, 24, [40, 80, 120]));
    await writeClipFixture(target, {
      width: 32,
      height: 24,
      png,
      project: { name: "My Animation", width: 1920, height: 1080 },
      layers: [
        // A paper row and a folder row are structure, not paint layers.
        { id: 1, name: "Background", type: 1584 },
        { id: 2, name: "Folder", folder: 1 },
        { id: 3, name: "Ink", opacity: 128 },
        { id: 4, name: "Hidden", visible: 0, locked: 1 },
      ],
    });

    const document = await readClipDocument(target);

    assert.equal(document.projectName, "My Animation");
    assert.equal(document.width, 1920);
    assert.equal(document.height, 1080);
    assert.equal(document.capabilities.layerMetadata, true);

    // Only the two paint layers survive.
    assert.equal(document.layers.length, 2);
    assert.deepEqual(document.layers.map((layer) => layer.name), ["Ink", "Hidden"]);

    const [ink, hidden] = document.layers;
    assert.equal(ink.opacity, 0.5);
    assert.equal(ink.visible, true);
    assert.equal(ink.locked, false);
    assert.equal(hidden.opacity, 1);
    assert.equal(hidden.visible, false);
    assert.equal(hidden.locked, true);
    assert.equal(ink.pixelDataSupported, false);

    assert.ok(document.tables.includes("Layer"));
    assert.ok(document.layerColumns.includes("LayerOpacity"));
  });
});

test("the container of a real Clip Studio document is read exactly", async () => {
  const bytes = Buffer.from(await fs.readFile(TEMPLATE));
  const container = parseClipContainer(bytes);

  assert.equal(container.chunks[0].name, "CHNKHead");
  assert.equal(container.chunks.at(-1).name, "CHNKFoot");
  assert.equal(container.chunks.at(-2).name, "CHNKSQLi");
  assert.ok(container.chunks.some((chunk) => chunk.name === "CHNKExta"));

  // The header records the size of the file and of the header itself.
  assert.equal(container.fileSize, container.size);
  assert.equal(container.headerSize, 24);

  // The head chunk records where the database starts, and that is the
  // offset of the CHNKSQLi chunk header.
  assert.equal(container.head.version, 256);
  assert.equal(container.head.databaseOffset, container.databaseOffset);
  assert.match(container.head.documentId, /^[0-9a-f]{32}$/);

  // Every chunk name is eight printable characters and the sizes add up.
  assert.equal(container.bytesConsumed, container.size);
});

test("the real document reports its tables, layers and external blobs", async () => {
  const bytes = Buffer.from(await fs.readFile(TEMPLATE));
  const document = await readClipDocumentFromBytes(bytes);

  assert.equal(document.format, "clip-studio-native-container");
  assert.equal(document.readOnly, true);
  assert.ok(document.tables.includes("CanvasPreview"));
  assert.ok(document.tables.includes("Offscreen"));
  assert.ok(document.tables.includes("ExternalChunk"));
  assert.ok(document.tableDetails.Offscreen.rows > 0);
  assert.ok(document.layerColumns.includes("LayerOpacity"));

  // The external blobs are found at the offsets the database gives.
  assert.ok(document.externalChunks.length > 0);
  for (const blob of document.externalChunks) {
    assert.equal(blob.present, true);
    assert.ok(blob.size > 0);
  }

  // The layers are classified, and the paper layer is not a paint layer.
  assert.ok(document.layerTree.length > 0);
  assert.ok(document.layerTree.some((layer) => layer.kind === "paper"));
  assert.ok(document.layers.every((layer) => layer.kind !== "paper"));
});

test("the pixels of a raster that lives outside the database are decoded", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "raster.clip");
    const size = 64;
    const pixels = Buffer.alloc(size * size * 4);
    for (let index = 0; index < size * size; index += 1) {
      pixels[index * 4] = 200;
      pixels[index * 4 + 1] = 40;
      pixels[index * 4 + 2] = 10;
      pixels[index * 4 + 3] = 255;
    }
    const { payload, sizes } = buildRasterPayload({ width: size, height: size, pixels });
    const id = "extrnlid0123456789ABCDEF0123456789ABCDEF";
    const attribute = buildOffscreenAttribute({ width: size, height: size, blockSizes: sizes });

    await writeClipFixture(target, {
      width: size,
      height: size,
      png: encodePng(size, size, solid(size, size, [0, 0, 0])),
      layers: [{ id: 1, name: "Ink", type: 1, mipmap: 1 }],
      raster: { id, layerId: 1, attribute, payload },
    });

    // The container is a real one: the blob sits in a CHNKExta chunk and the
    // database points at it by file offset.
    const container = parseClipContainer(Buffer.from(await fs.readFile(target)));
    const blob = container.chunks.find((chunk) => chunk.name === "CHNKExta");
    assert.ok(blob, "the fixture should hold an external chunk");
    assert.equal(blob.payload.subarray(8, 48).toString("ascii"), id);

    const layers = await readClipLayersFromBytes(Buffer.from(await fs.readFile(target)));
    assert.equal(layers.length, 1);
    const layer = layers[0];
    assert.equal(layer.name, "Ink");
    assert.equal(layer.width, size);
    assert.equal(layer.height, size);
    assert.equal(layer.tilesWithPixels, 1);

    // The colour comes back the way it went in.
    assert.equal(layer.pixels[0], 200);
    assert.equal(layer.pixels[1], 40);
    assert.equal(layer.pixels[2], 10);
    assert.equal(layer.pixels[3], 255);
    // The last pixel of the canvas is the last pixel of the tile.
    assert.equal(layer.pixels.at(-1), 255);
    assert.equal(layer.pixels.at(-4), 200);
  });
});

test("a written .clip reads back with the same pixels", async () => {
  const project = createProject(320, 240, "#ffffff");
  project.layers[0].drawings = [{
    at: 1,
    hold: 1,
    strokes: [{ color: "#ff0000", width: 10, points: [[40, 40], [280, 200]] }],
  }];

  const written = await createClipBuffer(project, { name: "round trip" });
  const layers = await readClipLayersFromBytes(written.buffer);

  assert.ok(layers.length > 0);
  const layer = layers[0];
  assert.equal(layer.width, 320);
  assert.equal(layer.height, 240);
  assert.equal(layer.pixels.length, 320 * 240 * 4);

  // The stroke is red, so the red channel has to be the strong one. This
  // catches a mistake in the blue, green, red order of a tile.
  let red = 0;
  let blue = 0;
  for (let index = 0; index < layer.pixels.length; index += 4) {
    if (layer.pixels[index + 3] === 0) continue;
    if (layer.pixels[index] > 200) red += 1;
    if (layer.pixels[index + 2] > 200) blue += 1;
  }
  assert.ok(red > 0, "the stroke should be red");
  assert.equal(blue, 0, "the stroke should not be blue");

  // The decoded pixels are the ones the renderer produced.
  const expected = renderLayerRgba(project, project.layers[0]);
  let matching = 0;
  for (let index = 0; index < expected.length; index += 4) {
    if (layer.pixels[index + 3] === 0) continue;
    if (
      Math.abs(layer.pixels[index] - expected[index]) < 8 &&
      Math.abs(layer.pixels[index + 1] - expected[index + 1]) < 8 &&
      Math.abs(layer.pixels[index + 2] - expected[index + 2]) < 8
    ) {
      matching += 1;
    }
  }
  assert.ok(matching > 100, `only ${matching} pixels matched`);
});

test("an action document is read and its properties are named", async () => {
  await withTempDir(async (dir) => {
    // The header of the serialised form CSP writes for a track: the magic,
    // the version, the codec, a checksum and the size of the string pool.
    const pool = [
      "null", "Byte", "UInt16", "Single",
      "ActionNodeClip", "TimeClip", "Start", "End", "Rate",
      "FCurve", "Type", "Frame", "Value", "LeftSlope", "RightSlope", "Interp", "Constant",
    ];
    const header = Buffer.alloc(20);
    header.write("cmt ", 0, "ascii");
    header.write("0100", 4, "ascii");
    header.write("binc", 8, "ascii");
    header.writeUInt32LE(0x12345678, 12);
    header.writeUInt32LE(pool.length, 16);
    const entries = Buffer.concat(
      pool.map((name) => {
        const text = Buffer.from(name, "ascii");
        return Buffer.concat([Buffer.from([text.length]), text]);
      }),
    );
    const body = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const document = Buffer.concat([header, entries, body]);

    const parsed = parseActionDocument(document);
    assert.equal(parsed.version, "0100");
    assert.equal(parsed.codec, "binc");
    assert.equal(parsed.checksum, 0x12345678);
    assert.equal(parsed.poolSize, pool.length);
    assert.deepEqual(parsed.types, ["null", "Byte", "UInt16", "Single"]);
    assert.ok(parsed.properties.includes("FCurve"));
    assert.ok(parsed.properties.includes("LeftSlope"));
    assert.deepEqual([...parsed.body], [...body]);
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


