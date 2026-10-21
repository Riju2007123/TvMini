/**
 * Import a .clip and write it out again with its timeline.
 *
 *   node tools/clip-export-animation.mjs source.clip out.clip
 *
 * The project is built the way the editor builds it, then the source file is
 * handed to the writer as the animation skeleton. What comes out is read back
 * to show where the cells of every track landed.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";
import { createClipBuffer } from "../src/clip-write.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve, readTrackRange } from "../public/core/clip-animation.js";

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

async function report(file) {
  const data = Buffer.from(fs.readFileSync(file));
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
  const key = (value) => (typeof value === "string"
    ? value.replace(/-/g, "").toLowerCase()
    : Buffer.from(value).toString("hex").toLowerCase());
  const names = new Map();
  for (const row of db.prepare("SELECT MainId, LayerName, LayerUuid FROM Layer").all()) {
    names.set(key(row.LayerUuid), `${row.MainId} "${row.LayerName}"`);
  }
  for (const track of db.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
    const blob = externals.get(Buffer.from(track.TrackActionMixer2).toString("ascii"));
    const document = blob ? readActionBlob(blob) : null;
    const curve = document ? readCelCurve(document) : null;
    const range = document ? readTrackRange(document) : null;
    console.log(
      `  track ${track.MainId} kind ${track.TrackKind} -> ${names.get(key(track.LayerUuidWithTrack)) ?? "?"} ` +
      `cels=[${curve ? curve.keys.map((one) => one.tag).join(" ") : "-"}] ` +
      `times=[${curve ? curve.keys.map((one) => one.time).join(" ") : "-"}] ` +
      `end=${range?.end ?? "-"}`,
    );
  }
  await db.close();
}

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error("usage: node tools/clip-export-animation.mjs source.clip out.clip");
  process.exit(2);
}

const data = Buffer.from(fs.readFileSync(source));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});
console.log(
  `imported ${project.width}x${project.height} ${project.fps}fps, ` +
  `${project.layers.length} layers, start ${project.startFrame}, frame ${project.currentFrame}`,
);

const written = await createClipBuffer(project, { name: "round trip", animation: data });
fs.writeFileSync(target, written.buffer);
console.log(`wrote ${target} (${written.buffer.length} bytes, ${written.layers} layers)`);
console.log("tracks in the written file:");
await report(target);
