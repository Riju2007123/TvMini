/**
 * Write a small animated .clip to look at in Clip Studio Paint.
 *
 *   node tools/clip-demo-animation.mjs C:\path\to\demo.clip
 *
 * Two rows of cells, drawn in bright colours, so that the timeline of the
 * written file can be checked by eye: the cells have to show in the order
 * they were drawn in, and the frame rate has to be the one of the project.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { createProject } from "../public/core/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve, readTrackRange } from "../public/core/clip-animation.js";

const target = process.argv[2] ?? "tvmini-animation-demo.clip";

const stroke = (color, from, to, width = 14) => ({
  color,
  width,
  points: [from, to],
});

const project = createProject(480, 270);
project.fps = 24;
project.layers = [
  {
    name: "Row One",
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
      { at: 1, hold: 4, name: "one", strokes: [stroke("#e04030", [60, 60], [200, 60])] },
      { at: 5, hold: 4, name: "two", strokes: [stroke("#30a0e0", [60, 100], [200, 100])] },
      { at: 9, hold: 4, name: "three", strokes: [stroke("#30b060", [60, 140], [200, 140])] },
    ],
  },
  {
    name: "Row Two",
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
      { at: 2, hold: 5, name: "a", strokes: [stroke("#e0a030", [240, 60], [400, 60])] },
      { at: 7, hold: 5, name: "b", strokes: [stroke("#a050e0", [240, 100], [400, 100])] },
    ],
  },
];

const written = await createClipBuffer(project, { name: "TVMini animation demo", animation: true });
fs.writeFileSync(target, written.buffer);
console.log(
  `wrote ${target} (${written.buffer.length} bytes, ${written.layers} layers, ${written.tracks} rows of cells)`,
);

// Read the file back and say what it holds.
const data = Buffer.from(fs.readFileSync(target));
let offset = 0x18;
let databaseBytes = null;
while (offset + 16 <= data.length) {
  const name = data.toString("ascii", offset, offset + 8);
  const size = Number(data.readBigUInt64BE(offset + 8));
  if (name === "CHNKSQLi") databaseBytes = data.subarray(offset + 16, offset + 16 + size);
  offset += 16 + size;
}
const database = await openDatabase(new Buffer(databaseBytes));
const externals = new Map();
for (const row of database.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  const at = Number(row.Offset);
  const size = Number(data.readBigUInt64BE(at + 8));
  const body = data.subarray(at + 16, at + 16 + size);
  externals.set(Buffer.from(row.ExternalID).toString("ascii"), body);
}

console.log("\n== the timeline ==");
for (const row of database.prepare("SELECT * FROM TimeLine").all()) {
  console.log(
    ` ${row.TimeLineName}: ${row.FrameRate} fps, frames ${Number(row.StartFrame) + 1}..${Number(row.EndFrame)}, current ${Number(row.CurrentFrame) + 1}`,
  );
}

console.log("\n== the tracks ==");
for (const row of database.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
  const id = Buffer.from(row.TrackActionMixer2).toString("ascii");
  const document = readActionBlob(externals.get(id));
  const cells = readCelCurve(document);
  const range = readTrackRange(document);
  console.log(
    ` track ${row.MainId} kind ${row.TrackKind}: range ${range.start}..${range.end} ticks, cells ${
      cells ? cells.keys.map((key) => `${key.tag}@${key.time}`).join(" ") : "-"
    }`,
  );
}

console.log("\n== the layers ==");
for (const row of database.prepare("SELECT MainId, LayerName, LayerType, LayerFolder, AnimationFolder FROM Layer ORDER BY MainId").all()) {
  console.log(
    ` ${row.MainId} "${row.LayerName}" type ${row.LayerType} folder ${row.LayerFolder} animation folder ${row.AnimationFolder ?? 0}`,
  );
}
