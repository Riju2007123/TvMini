import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { createProject, normalizeProject } from "../public/core/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { readActionBlob, readCameraCurves } from "../public/core/clip-animation.js";
import {
  buildCurveRecord,
  buildDocument,
  celCurveFields,
  encodeMixerPayload,
  withStrings,
} from "../public/core/clip-mixer.js";
import { clipToProject, readClipDocumentFromBytes } from "../public/core/clip.js";

/**
 * The table definitions a Clip Studio document with a timeline carries.
 * They are read out of a real document; the writer copies them as they are,
 * so a document written here has the same shape as one CSP wrote.
 */
const TIME_LINE_SQL =
  "CREATE TABLE TimeLine(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, MainId INTEGER DEFAULT NULL, " +
  "BankId INTEGER DEFAULT NULL, NextTimeLine INTEGER DEFAULT NULL, NextScenario INTEGER DEFAULT NULL, " +
  "FirstTrack INTEGER DEFAULT NULL, TimeLineUuid BLOB DEFAULT NULL, TimeLineName TEXT DEFAULT NULL, " +
  "SceneIndexForName INTEGER DEFAULT NULL, CutIndexForName INTEGER DEFAULT NULL, CurrentFrame REAL DEFAULT NULL, " +
  "FrameRate REAL DEFAULT NULL, StartFrame REAL DEFAULT NULL, EndFrame REAL DEFAULT NULL, " +
  "GuidelineFrameRate INTEGER DEFAULT NULL, LabelFirstIndex INTEGER DEFAULT NULL, " +
  "SmallestStartFrame REAL DEFAULT NULL, BiggestEndFrame REAL DEFAULT NULL)";

const TRACK_SQL =
  "CREATE TABLE Track(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, MainId INTEGER DEFAULT NULL, " +
  "BankId INTEGER DEFAULT NULL, ItemId INTEGER DEFAULT NULL, TrackNextIndex INTEGER DEFAULT NULL, " +
  "TrackActionMixerSize INTEGER DEFAULT NULL, TrackActionMixer BLOB DEFAULT NULL, " +
  "TrackActionMixer2Size INTEGER DEFAULT NULL, TrackActionMixer2 BLOB DEFAULT NULL, " +
  "TrackValueMap BLOB DEFAULT NULL, TrackOpen INTEGER DEFAULT NULL, TrackContentOpen INTEGER DEFAULT NULL, " +
  "TrackUuid BLOB DEFAULT NULL, LayerUuidWithTrack BLOB DEFAULT NULL, TrackKind INTEGER DEFAULT NULL, " +
  "TrackOptionFlag INTEGER DEFAULT NULL)";

/** The string pool a track document uses. */
const POOL = [
  "null", "Byte", "SByte", "UInt16", "Int16", "UInt32", "Int32", "Single",
  "Double", "String", "Double[]", "String[]", "Int32[]", "Byte[]",
  "TimeClip", "Start", "End", "Rate", "FCurve", "Type", "Axis", "Frame",
  "Value", "LeftSlope", "RightSlope", "Interp", "Tag", "Constant",
  "ImageCelName", "ImageCenter", "ImagePosition", "ImageRotation",
  "ImageScale", "X", "Y",
];

/** A chunk of the container: its name, its size and its body. */
function chunk(name, body) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length), 0);
  return Buffer.concat([Buffer.from(name, "ascii"), size, body]);
}

/** The container CSP reads: a header, the head, the blobs, the database. */
function container(parts) {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(24);
  header.write("CSFCHUNK", 0, "ascii");
  header.writeBigUInt64BE(BigInt(24 + body.length), 8);
  header.writeBigUInt64BE(BigInt(24), 16);
  return Buffer.concat([header, body]);
}

/** The range words a track carries: `Start`, `End` and `Rate`. */
function rangeRecord(pool, name, value) {
  const words = Buffer.alloc(16);
  words.writeUInt32LE(pool.indexOf(name), 0);
  words.writeUInt32LE(pool.indexOf("Double"), 4);
  words.writeDoubleLE(value, 8);
  return words;
}

/** The action document of a cell track, with one cell curve. */
function celDocument() {
  const pool = withStrings(POOL, ["1"]);
  const curve = buildCurveRecord({
    pool,
    kind: "ImageCelName",
    fields: celCurveFields([{ time: 0, value: 0, tag: "1" }], pool),
  });
  return buildDocument({
    pool,
    body: Buffer.concat([rangeRecord(pool, "End", 60), curve]),
  });
}

/**
 * The action document of a camera track: the six curves of a camera, with
 * the times and the values of the keys it holds.
 */
function cameraDocument(keys) {
  const pool = withStrings(POOL, []);
  const series = [
    ["ImageCenter", "X", keys.map((key) => key.width / 2)],
    ["ImageCenter", "Y", keys.map((key) => key.height / 2)],
    ["ImagePosition", "X", keys.map((key) => key.x + key.width / 2)],
    ["ImagePosition", "Y", keys.map((key) => key.y + key.height / 2)],
    ["ImageRotation", null, keys.map((key) => key.rotation)],
    ["ImageScale", null, keys.map(() => 100)],
  ];
  const records = series.map(([kind, axis, values]) =>
    buildCurveRecord({
      pool,
      kind,
      axis,
      fields: [
        { name: "Frame", type: "Double[]", values: keys.map((key) => key.time) },
        { name: "Value", type: "Double[]", values },
      ],
    }),
  );
  return buildDocument({
    pool,
    body: Buffer.concat([
      rangeRecord(pool, "Start", 0),
      rangeRecord(pool, "End", 60),
      rangeRecord(pool, "Rate", 60),
      ...records,
    ]),
  });
}

/**
 * A `.clip` that holds a cell track and a camera track, built the way a
 * document CSP wrote holds them: the table definitions, the rows, and the
 * mixer blobs of both tracks.
 */
async function cameraSkeletonClip({ camera = true } = {}) {
  const firstId = `extrnlid${"0".repeat(30)}AA`;
  const secondId = `extrnlid${"0".repeat(30)}BB`;
  const cameraFirstId = `extrnlid${"0".repeat(30)}CC`;
  const cameraSecondId = `extrnlid${"0".repeat(30)}DD`;
  const cel = celDocument();
  const keys = [{ time: 0, x: 0, y: 0, width: 64, height: 48, rotation: 0 }];
  const cameraFirst = cameraDocument(keys);
  const cameraSecond = cameraDocument(keys);

  const database = await openDatabase(Buffer.from(new Uint8Array(0)));
  database.exec(TIME_LINE_SQL);
  database.exec(TRACK_SQL);
  database.exec(
    "CREATE TABLE AnimationCutBank(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, MainId INTEGER DEFAULT NULL, " +
      "FirstTimeLine INTEGER DEFAULT NULL, FirstScenario INTEGER DEFAULT NULL, CurrentIndex INTEGER DEFAULT NULL, " +
      "Enable INTEGER DEFAULT NULL, FlagScenarioV155 INTEGER DEFAULT NULL)",
  );
  database
    .prepare(
      "INSERT INTO TimeLine (MainId, BankId, NextTimeLine, NextScenario, FirstTrack, TimeLineUuid, TimeLineName, " +
        "SceneIndexForName, CutIndexForName, CurrentFrame, FrameRate, StartFrame, EndFrame, GuidelineFrameRate, " +
        "LabelFirstIndex, SmallestStartFrame, BiggestEndFrame) " +
        "VALUES (1, 2, 0, 0, 1, ?, 'Timeline 1', 1, 1, 0, 12, 0, 10, 6, 0, 0, 60)",
    )
    .run(new Uint8Array(16));
  const insertTrack = database.prepare(
    "INSERT INTO Track (MainId, BankId, ItemId, TrackNextIndex, TrackActionMixerSize, TrackActionMixer, " +
      "TrackActionMixer2Size, TrackActionMixer2, TrackValueMap, TrackOpen, TrackContentOpen, TrackUuid, " +
      "LayerUuidWithTrack, TrackKind, TrackOptionFlag) " +
      "VALUES (?, 2, 1, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)",
  );
  insertTrack.run(
    1,
    2,
    cel.length,
    Buffer.from(firstId, "ascii"),
    cel.length,
    Buffer.from(secondId, "ascii"),
    new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0]),
    new Uint8Array(16),
    new Uint8Array(16),
    2000,
    768,
  );
  const blobs = [
    chunk("CHNKExta", encodeMixerPayload(cel, firstId)),
    chunk("CHNKExta", encodeMixerPayload(cel, secondId)),
  ];
  if (camera) {
    insertTrack.run(
      2,
      0,
      cameraFirst.length,
      Buffer.from(cameraFirstId, "ascii"),
      cameraSecond.length,
      Buffer.from(cameraSecondId, "ascii"),
      new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      2005,
      256,
    );
    blobs.push(
      chunk("CHNKExta", encodeMixerPayload(cameraFirst, cameraFirstId)),
      chunk("CHNKExta", encodeMixerPayload(cameraSecond, cameraSecondId)),
    );
  }
  const bytes = Buffer.from(await database.export());
  await database.close();

  return container([
    chunk("CHNKHead", Buffer.alloc(40)),
    ...blobs,
    chunk("CHNKSQLi", bytes),
    chunk("CHNKFoot", Buffer.alloc(0)),
  ]);
}

function databaseOf(buffer) {
  let offset = 0x18;
  while (offset + 16 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 8);
    const size = Number(buffer.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return buffer.subarray(offset + 16, offset + 16 + size);
    offset += 16 + size;
  }
  throw new Error("the written file has no database");
}

function externalOf(buffer, id) {
  let offset = 0x18;
  while (offset + 16 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 8);
    const size = Number(buffer.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta") {
      const body = buffer.subarray(offset + 16, offset + 16 + size);
      if (body.toString("ascii", 8, 48) === id) return body;
    }
    offset += 16 + size;
  }
  return null;
}

/** A project with an animation folder, a cell and a camera with two keys. */
function projectWithCamera() {
  return normalizeProject({
    ...createProject(64, 48),
    fps: 12,
    layers: [
      {
        name: "Camera 1",
        type: "group",
        camera: true,
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "hold",
        postBehavior: "hold",
        clip: false,
        parent: -1,
        drawings: [],
      },
      {
        name: "Cels",
        type: "group",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "hold",
        postBehavior: "hold",
        clip: false,
        parent: 0,
        drawings: [],
      },
      {
        name: "one",
        type: "anim",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        preBehavior: "none",
        postBehavior: "none",
        clip: false,
        parent: 1,
        drawings: [{ at: 1, hold: 1, strokes: [], name: "one" }],
      },
    ],
    camera: {
      keys: [
        { frame: 1, x: 0, y: 0, width: 64, height: 48, rotation: 0, interp: "linear" },
        { frame: 11, x: 8, y: 6, width: 32, height: 24, rotation: 10, interp: "linear" },
      ],
    },
  });
}

test("a camera is written as a track hung on its own layer", async () => {
  const written = await createClipBuffer(projectWithCamera(), {
    name: "camera",
    animation: await cameraSkeletonClip(),
  });

  const database = await openDatabase(Buffer.from(databaseOf(written.buffer)));
  const tracks = database.prepare("SELECT * FROM Track ORDER BY MainId").all();
  const layers = database.prepare("SELECT * FROM Layer ORDER BY MainId").all();
  await database.close();

  const cameraTrack = tracks.find((track) => Number(track.TrackKind) === 2005);
  assert.ok(cameraTrack, "the camera track is in the file");
  assert.ok(
    tracks.some((track) => Number(track.TrackKind) === 2000),
    "the cell track is still there",
  );

  // The camera hangs on the folder of the project that says it is the camera,
  // and that layer is a camera layer of Clip Studio Paint.
  const cameraLayer = layers.find((layer) => Number(layer.LayerType) === 512);
  assert.ok(cameraLayer, "the camera layer is a layer of type 512");
  assert.equal(cameraLayer.LayerName, "Camera 1");
  assert.equal(Number(cameraLayer.LayerFolder), 1);
  // The layer keeps its uuid as text; the track names it as its 16 bytes.
  assert.deepEqual(
    Buffer.from(cameraTrack.LayerUuidWithTrack),
    Buffer.from(String(cameraLayer.LayerUuid).replace(/-/g, ""), "hex"),
    "the track names the camera layer",
  );
});

test("the camera keys of the track are the keys of the project", async () => {
  const written = await createClipBuffer(projectWithCamera(), {
    name: "camera",
    animation: await cameraSkeletonClip(),
  });

  const database = await openDatabase(Buffer.from(databaseOf(written.buffer)));
  const track = database
    .prepare("SELECT * FROM Track WHERE TrackKind = 2005 ORDER BY MainId LIMIT 1")
    .get();
  await database.close();

  const id = Buffer.from(track.TrackActionMixer2).toString("ascii");
  const document = readActionBlob(externalOf(written.buffer, id));
  assert.ok(document, "the camera's mixer is in the file");

  const camera = readCameraCurves(document);
  assert.ok(camera, "the mixer holds the curves of a camera");
  // Twelve frames a second, so a frame is five ticks.
  assert.deepEqual(camera.keys.map((key) => key.time), [0, 50]);
  assert.deepEqual(camera.keys.map((key) => key.centreX), [32, 16]);
  assert.deepEqual(camera.keys.map((key) => key.centreY), [24, 12]);
  assert.deepEqual(camera.keys.map((key) => key.positionX), [32, 24]);
  assert.deepEqual(camera.keys.map((key) => key.positionY), [24, 18]);
  assert.deepEqual(camera.keys.map((key) => key.rotation), [0, 10]);
  assert.deepEqual(camera.keys.map((key) => key.scale), [100, 100]);
});

test("the camera comes back on import the way it went out", async () => {
  const written = await createClipBuffer(projectWithCamera(), {
    name: "camera",
    animation: await cameraSkeletonClip(),
  });

  const document = await readClipDocumentFromBytes(Buffer.from(written.buffer));
  const project = clipToProject(document, [], {});
  assert.ok(project.camera, "the document has a camera");
  assert.deepEqual(
    project.camera.keys.map((key) => ({
      frame: key.frame,
      x: key.x,
      y: key.y,
      width: key.width,
      height: key.height,
      rotation: key.rotation,
    })),
    [
      { frame: 1, x: 0, y: 0, width: 64, height: 48, rotation: 0 },
      { frame: 11, x: 8, y: 6, width: 32, height: 24, rotation: 10 },
    ],
  );

  // The camera layer comes back as a folder that says it is the camera, so a
  // second export can hang the track on it again.
  const cameraLayer = project.layers.find((layer) => layer.camera === true);
  assert.ok(cameraLayer, "the camera layer is marked as one");
  assert.equal(cameraLayer.name, "Camera 1");
  assert.equal(cameraLayer.type, "group");
});

test("a skeleton without a camera writes none, and a project without keys gets none", async () => {
  // The bundled animation template has no camera track, so there is no tree
  // of a camera to copy and the writer does not make one up.
  const noCamera = await createClipBuffer(projectWithCamera(), {
    name: "camera",
    animation: await cameraSkeletonClip({ camera: false }),
  });
  let database = await openDatabase(Buffer.from(databaseOf(noCamera.buffer)));
  let tracks = database.prepare("SELECT TrackKind FROM Track").all();
  await database.close();
  assert.ok(!tracks.some((track) => Number(track.TrackKind) === 2005));

  // A project with no camera keys keeps the camera layer but gets no track.
  const project = projectWithCamera();
  project.camera = null;
  const written = await createClipBuffer(project, {
    name: "no camera",
    animation: await cameraSkeletonClip(),
  });
  database = await openDatabase(Buffer.from(databaseOf(written.buffer)));
  tracks = database.prepare("SELECT TrackKind FROM Track").all();
  const cameraLayers = database
    .prepare("SELECT COUNT(*) AS n FROM Layer WHERE LayerType = 512")
    .get();
  await database.close();
  assert.ok(!tracks.some((track) => Number(track.TrackKind) === 2005));
  assert.equal(Number(cameraLayers.n), 1);
});

test("a written camera is written again when the file is imported and exported", async () => {
  // The path a document with a camera really takes: import it, export it
  // again with itself as the skeleton, and the camera is still there.
  const first = await createClipBuffer(projectWithCamera(), {
    name: "first",
    animation: await cameraSkeletonClip(),
  });
  const document = await readClipDocumentFromBytes(Buffer.from(first.buffer));
  const project = clipToProject(document, [], {});
  assert.ok(project.camera, "the imported project has the camera");

  const second = await createClipBuffer(project, {
    name: "second",
    animation: Buffer.from(first.buffer),
  });
  const again = clipToProject(
    await readClipDocumentFromBytes(Buffer.from(second.buffer)),
    [],
    {},
  );
  assert.deepEqual(
    again.camera.keys.map((key) => ({
      frame: key.frame,
      x: key.x,
      y: key.y,
      width: key.width,
      height: key.height,
      rotation: key.rotation,
    })),
    [
      { frame: 1, x: 0, y: 0, width: 64, height: 48, rotation: 0 },
      { frame: 11, x: 8, y: 6, width: 32, height: 24, rotation: 10 },
    ],
  );
});
