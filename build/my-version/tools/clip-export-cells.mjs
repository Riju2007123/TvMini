/**
 * Export a project that never came from a .clip, with cells of its own.
 *
 *   node tools/clip-export-cells.mjs out.clip
 *
 * The project has one layer with three drawings, so the writer has to make
 * the cells of a row and the track that shows them. The skeleton is the
 * small document with a real animation in it that ships with the program.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { createProject } from "../public/core/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve } from "../public/core/clip-animation.js";

const target = process.argv[2] ?? "cells.clip";

const project = createProject(200, 150);
project.fps = 12;
project.layers[0].name = "Dots";
project.layers[0].drawings = [
  {
    at: 1,
    hold: 1,
    name: "first",
    strokes: [{ color: "#ff0000", width: 20, points: [[40, 40], [90, 90]] }],
  },
  {
    at: 3,
    hold: 1,
    name: "second",
    strokes: [{ color: "#00aa00", width: 20, points: [[60, 40], [110, 90]] }],
  },
  {
    at: 5,
    hold: 1,
    name: "third",
    strokes: [{ color: "#0000ff", width: 20, points: [[80, 40], [130, 90]] }],
  },
];

const written = await createClipBuffer(project, { name: "cells", animation: true });
fs.writeFileSync(target, written.buffer);
console.log(`wrote ${target} (${written.buffer.length} bytes, ${written.layers} layers, ${written.tracks} tracks)`);

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
  let at = 0x18;
  while (at + 16 <= data.length) {
    const name = data.toString("ascii", at, at + 8);
    const size = Number(data.readBigUInt64BE(at + 8));
    if (name === "CHNKExta" && at === Number(row.Offset)) {
      externals.set(Buffer.from(row.ExternalID).toString("ascii"), data.subarray(at + 16, at + 16 + size));
      break;
    }
    at += 16 + size;
  }
}
for (const track of database.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
  const blob = externals.get(Buffer.from(track.TrackActionMixer2).toString("ascii"));
  const curve = blob ? readCelCurve(readActionBlob(blob)) : null;
  console.log(
    `  track ${track.MainId} kind ${track.TrackKind} ` +
      `cels=[${curve ? curve.keys.map((key) => key.tag).join(" ") : "-"}] ` +
      `times=[${curve ? curve.keys.map((key) => key.time).join(" ") : "-"}]`,
  );
}
const layers = database.prepare("SELECT MainId, LayerName, LayerFolder, AnimationFolder FROM Layer ORDER BY MainId").all();
for (const layer of layers) {
  console.log(`  layer ${layer.MainId} "${layer.LayerName}" folder=${layer.LayerFolder} anim=${layer.AnimationFolder ?? ""}`);
}
await database.close();
