/**
 * Print the curves of one track of a .clip, with their values.
 *
 *   node tools/curve-values.mjs file.clip <trackId> [mixer]
 *
 * The camera of a document is a track of kind 2005 whose curves hold the
 * centre, the position, the rotation and the scale of the view.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readAnimationCurves } from "../public/core/clip-animation.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    offset += 16 + size;
  }
  return null;
}

const [file, trackText, mixer = "2"] = process.argv.slice(2);
const data = fs.readFileSync(file);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const externals = new Map();
for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta" && offset === Number(row.Offset)) {
      externals.set(Buffer.from(row.ExternalID).toString("ascii"), data.subarray(offset + 16, offset + 16 + size));
      break;
    }
    offset += 16 + size;
  }
}

const track = db.prepare("SELECT * FROM Track WHERE MainId = ?").get(Number(trackText));
if (!track) throw new Error(`no track ${trackText}`);
console.log(`track ${track.MainId} kind ${track.TrackKind} option ${track.TrackOptionFlag}`);

const column = mixer === "1" ? "TrackActionMixer" : "TrackActionMixer2";
const blob = externals.get(Buffer.from(track[column]).toString("ascii"));
const document = readActionBlob(blob);
if (!document) throw new Error("the mixer could not be read");

for (const curve of readAnimationCurves(document)) {
  console.log(`  curve ${curve.kind} axis=${curve.axis ?? "-"}`);
  for (const [name, field] of curve.fields) {
    const values = field.values.map((value) =>
      typeof value === "number" ? Math.round(value * 1000) / 1000 : value,
    );
    console.log(`    ${name} (${field.type}): ${JSON.stringify(values)}`);
  }
}
await db.close();
