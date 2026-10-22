import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { createProject } from "../public/core/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { readActionBlob, readCelCurve, readTrackRange } from "../public/core/clip-animation.js";
import {
  buildCurveRecord,
  buildDocument,
  celCurveFields,
  encodeMixerPayload,
  locateCurve,
  withStrings,
} from "../public/core/clip-mixer.js";
import { readClipLayersFromBytes } from "../public/core/clip.js";

/**
 * The table definitions a Clip Studio document with a timeline carries.
 *
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

/** The string pool a cell track's document uses. */
const POOL = [
  "null", "Byte", "SByte", "UInt16", "Int16", "UInt32", "Int32", "Single",
  "Double", "String", "Double[]", "String[]", "Int32[]", "Byte[]",
  "TimeClip", "Start", "End", "Rate", "FCurve", "Type", "ImageCelName",
  "Frame", "Value", "LeftSlope", "RightSlope", "Interp", "Tag", "Constant",
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

/** The action document of a cell track, with one cell curve. */
function mixerDocument(cels) {
  const pool = withStrings(POOL, cels.map((cel) => cel.tag));
  const curve = buildCurveRecord({
    pool,
    kind: "ImageCelName",
    fields: celCurveFields(
      cels.map((cel, index) => ({ time: cel.time, value: index, tag: cel.tag })),
      pool,
    ),
  });
  const range = Buffer.alloc(16);
  range.writeUInt32LE(pool.indexOf("End"), 0);
  range.writeUInt32LE(pool.indexOf("Double"), 4);
  range.writeDoubleLE(60, 8);
  return buildDocument({ pool, body: Buffer.concat([range, curve]) });
}

/**
 * A `.clip` that holds one cell track, built the way a document CSP wrote
 * holds one: the table definitions, the rows, and the two mixer blobs.
 */
async function skeletonClip() {
  const firstId = `extrnlid${"0".repeat(30)}AA`;
  const secondId = `extrnlid${"0".repeat(30)}BB`;
  const first = mixerDocument([{ time: 0, tag: "1" }]);
  const second = mixerDocument([{ time: 0, tag: "1" }]);

  const database = await openDatabase(new Buffer(alloc(0)));
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
        "VALUES (1, 2, 0, 0, 1, ?, 'Timeline 1', 1, 1, 0, 30, 0, 10, 6, 0, 0, 60)",
    )
    .run(new Uint8Array(16));
  database
    .prepare(
      "INSERT INTO Track (MainId, BankId, ItemId, TrackNextIndex, TrackActionMixerSize, TrackActionMixer, " +
        "TrackActionMixer2Size, TrackActionMixer2, TrackValueMap, TrackOpen, TrackContentOpen, TrackUuid, " +
        "LayerUuidWithTrack, TrackKind, TrackOptionFlag) " +
        "VALUES (1, 2, 1, 0, ?, ?, ?, ?, ?, 0, 0, ?, ?, 2000, 768)",
    )
    .run(
      first.length,
      Buffer.from(firstId, "ascii"),
      second.length,
      Buffer.from(secondId, "ascii"),
      new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0]),
      new Uint8Array(16),
      new Uint8Array(16),
    );
  const bytes = Buffer.from(await database.export());
  await database.close();

  const head = Buffer.alloc(40);
  const blobs = [first, second].map((document, index) =>
    chunk("CHNKExta", encodeMixerPayload(document, index === 0 ? firstId : secondId)),
  );
  return container([
    chunk("CHNKHead", head),
    ...blobs,
    chunk("CHNKSQLi", bytes),
    chunk("CHNKFoot", Buffer.alloc(0)),
  ]);
}

/** A zeroed buffer of the size asked for. */
function alloc(size) {
  return new Uint8Array(size);
}

/** Read the tracks of a written `.clip`. */
async function tracksOf(buffer) {
  const database = await openDatabase(new Buffer(databaseOf(buffer)));
  const rows = database.prepare("SELECT * FROM Track ORDER BY MainId").all();
  const timeline = database.prepare("SELECT * FROM TimeLine").all();
  await database.close();
  return { rows, timeline };
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

/** A project with one animation folder that holds three cells. */
function projectWithCells() {
  const project = createProject(64, 48);
  project.fps = 12;
  project.layers = [
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
      parent: -1,
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
      parent: 0,
      drawings: [{ at: 1, hold: 1, strokes: [], name: "one" }],
    },
    {
      name: "two",
      type: "anim",
      visible: true,
      locked: false,
      opacity: 1,
      blend: "normal",
      preBehavior: "none",
      postBehavior: "none",
      clip: false,
      parent: 0,
      drawings: [{ at: 3, hold: 1, strokes: [], name: "two" }],
    },
    {
      name: "three",
      type: "anim",
      visible: true,
      locked: false,
      opacity: 1,
      blend: "normal",
      preBehavior: "none",
      postBehavior: "none",
      clip: false,
      parent: 0,
      drawings: [{ at: 5, hold: 1, strokes: [], name: "three" }],
    },
  ];
  return project;
}

test("an animation folder is written as a track with its cells", async () => {
  const skeleton = await skeletonClip();
  const written = await createClipBuffer(projectWithCells(), {
    name: "animated",
    animation: skeleton,
  });

  const { rows, timeline } = await tracksOf(written.buffer);
  assert.equal(rows.length, 1);
  const track = rows[0];
  assert.equal(Number(track.TrackKind), 2000);

  const id = Buffer.from(track.TrackActionMixer2).toString("ascii");
  const document = readActionBlob(externalOf(written.buffer, id));
  assert.ok(document, "the track's mixer is in the file");

  const curve = readCelCurve(document);
  assert.deepEqual(curve.keys.map((key) => key.tag), ["one", "two", "three"]);
  // Twelve frames a second, so a frame is five ticks.
  assert.deepEqual(curve.keys.map((key) => key.time), [0, 10, 20]);
  assert.deepEqual(curve.keys.map((key) => key.value), [0, 1, 2]);

  // The track ends where the last cell ends: its end is the boundary after
  // that cell (frame 5 shown, so the boundary is frame 6 = tick 25), so that
  // cell is held for its own length and no longer. A track that ran to the
  // end of the document would hold it for every frame after it, and the
  // animation would stand still.
  const range = readTrackRange(document);
  assert.equal(range.end, 25);
  assert.equal(timeline.length, 1);
  assert.equal(Number(timeline[0].FrameRate), 12);
  assert.equal(Number(timeline[0].FirstTrack), Number(track.MainId));
  assert.equal(Number(timeline[0].EndFrame), 5);
});

test("a cell that is held longer keeps its own length in the track", async () => {
  // The last cell of a row is held until the end of the track, so the track
  // has to end where that cell ends. A track that ran to the end of the
  // document would hold the cell for every frame after it, and the animation
  // would stand still in Clip Studio Paint.
  const project = projectWithCells();
  project.layers[3].drawings = [{ at: 5, hold: 4, strokes: [], name: "three" }];

  const skeleton = await skeletonClip();
  const written = await createClipBuffer(project, { name: "animated", animation: skeleton });
  const { rows } = await tracksOf(written.buffer);
  const track = rows.find((row) => Number(row.TrackKind) === 2000);

  const id = Buffer.from(track.TrackActionMixer2).toString("ascii");
  const document = readActionBlob(externalOf(written.buffer, id));
  const range = readTrackRange(document);
  // Twelve frames a second, so a frame is five ticks: the cell shows frames
  // 5 to 8, and the track ends on the boundary after it, frame 9 = tick 40.
  assert.equal(range.end, 40);
});

test("the layer of an animation folder is marked as one", async () => {  const skeleton = await skeletonClip();
  const written = await createClipBuffer(projectWithCells(), {
    name: "animated",
    animation: skeleton,
  });
  const database = await openDatabase(new Buffer(databaseOf(written.buffer)));
  const folders = database
    .prepare("SELECT LayerName, AnimationFolder FROM Layer WHERE AnimationFolder = 1")
    .all();
  await database.close();
  assert.equal(folders.length, 1);
  assert.equal(folders[0].LayerName, "Cels");
});

test("a .clip without a cell track cannot be the skeleton", async () => {
  const template = await fs.readFile(
    new URL("../public/assets/clip-template.clip", import.meta.url),
  );
  await assert.rejects(
    () => createClipBuffer(projectWithCells(), { name: "no skeleton", animation: template }),
    /no cell track/,
  );
});

test("something that is not a .clip is refused as the skeleton", async () => {
  await assert.rejects(
    () => createClipBuffer(projectWithCells(), { name: "junk", animation: Buffer.from("hello") }),
    /not a Clip Studio file/,
  );
});

/** A project with one layer that holds two drawings. */
function projectWithDrawings() {
  const project = createProject(64, 48);
  project.fps = 24;
  project.layers = [
    {
      name: "Row",
      type: "anim",
      visible: true,
      locked: false,
      opacity: 1,
      blend: "normal",
      preBehavior: "hold",
      postBehavior: "hold",
      clip: false,
      parent: -1,
      drawings: [
        {
          at: 1,
          hold: 2,
          strokes: [{ color: "#ff0000", width: 6, points: [[10, 10], [40, 30]] }],
        },
        {
          at: 4,
          hold: 1,
          strokes: [{ color: "#00ff00", width: 6, points: [[20, 20], [50, 40]] }],
        },
      ],
    },
  ];
  return project;
}

test("the bundled document with a real animation is the skeleton of an export", async () => {
  const written = await createClipBuffer(projectWithDrawings(), {
    name: "animated",
    animation: true,
  });
  assert.equal(written.tracks, 1, "the file carries a row of cells");

  const { rows, timeline } = await tracksOf(written.buffer);
  // The track of the paper and the track of the row of cells.
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].TrackKind), 2003);
  assert.equal(Number(rows[1].TrackKind), 2000);
  // The tracks form a list, and the timeline points at the first one.
  assert.equal(Number(rows[0].TrackNextIndex), Number(rows[1].MainId));
  assert.equal(timeline.length, 1);
  assert.equal(Number(timeline[0].FirstTrack), Number(rows[0].MainId));
  assert.equal(Number(timeline[0].FrameRate), 24);

  // The cells of the row are the two drawings, at the frames they start on.
  const id = Buffer.from(rows[1].TrackActionMixer2).toString("ascii");
  const document = readActionBlob(externalOf(written.buffer, id));
  const curve = readCelCurve(document);
  assert.deepEqual(curve.keys.map((key) => key.tag), ["1", "2"]);
  // Twenty four frames a second, so a frame is 2.5 ticks.
  assert.deepEqual(curve.keys.map((key) => key.time), [0, 7.5]);
});

test("both mixers of a track carry the same cells", async () => {
  const written = await createClipBuffer(projectWithDrawings(), {
    name: "animated",
    animation: true,
  });
  const { rows } = await tracksOf(written.buffer);
  const track = rows.find((row) => Number(row.TrackKind) === 2000);

  for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
    const id = Buffer.from(track[column]).toString("ascii");
    const document = readActionBlob(externalOf(written.buffer, id));
    assert.ok(document, `the ${column} is in the file`);

    // The reader only understands the newer flavour, so the older one is
    // read with the writer's own walk.
    const curve = locateCurve(document, "ImageCelName");
    assert.ok(curve, `the ${column} holds a cell curve`);
    assert.deepEqual(
      curve.fields.get("Tag").values.map((index) => document.pool[index]),
      ["1", "2"],
    );
    assert.deepEqual(curve.fields.get("Frame").values, [0, 7.5]);
  }
});

test("the cells of a row are layers that hold the drawings", async () => {
  const written = await createClipBuffer(projectWithDrawings(), {
    name: "animated",
    animation: true,
  });
  const database = await openDatabase(new Buffer(databaseOf(written.buffer)));
  const layers = database
    .prepare("SELECT MainId, LayerName, LayerType, LayerFolder, AnimationFolder, LayerFirstChildIndex, LayerNextIndex FROM Layer ORDER BY MainId")
    .all();
  await database.close();

  const byId = new Map(layers.map((layer) => [Number(layer.MainId), layer]));
  const folder = layers.find((layer) => Number(layer.AnimationFolder ?? 0) === 1);
  assert.ok(folder, "the row is an animation folder");
  assert.equal(folder.LayerName, "Row");
  assert.equal(Number(folder.LayerFolder), 1);
  assert.equal(Number(folder.LayerType), 0);

  // The cells of the row are layers of their own, in the order they play.
  const cells = [];
  let at = Number(folder.LayerFirstChildIndex);
  while (at && byId.has(at)) {
    cells.push(byId.get(at).LayerName);
    at = Number(byId.get(at).LayerNextIndex);
  }
  assert.deepEqual(cells, ["1", "2"]);

  // Each of them holds a picture.
  const painted = await readClipLayersFromBytes(written.buffer);
  for (const cell of painted) {
    if (!["1", "2"].includes(cell.name)) continue;
    const marked = cell.pixels.filter((value, index) => index % 4 !== 3 && value !== 0).length;
    assert.ok(marked > 0, `the cell ${cell.name} holds a picture`);
  }
});
