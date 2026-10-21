/**
 * Round trip every .clip of a folder and compare the cells before and after.
 *
 *   node tools/clip-roundtrip-corpus.mjs <dir-or-file> [...]
 *
 * Each document is imported the way the editor imports it, written out again
 * with the document itself as the skeleton of the tracks, and read back. The
 * cells of every track are compared: a writer that keeps them keeps the
 * timeline of the document.
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";
import { createClipBuffer } from "../src/clip-write.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve } from "../public/core/clip-animation.js";

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

/** The cells of every cell track of a document, in the order of the tracks. */
async function cellsOf(data) {
  const database = await openDatabase(new Buffer(extractDatabase(data)));
  const externals = new Map();
  for (const row of database.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
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
  const tracks = [];
  for (const track of database.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
    if (Number(track.TrackKind) !== 2000) continue;
    const blob = externals.get(Buffer.from(track.TrackActionMixer2).toString("ascii"));
    const curve = blob ? readCelCurve(readActionBlob(blob)) : null;
    if (!curve) continue;
    tracks.push({
      name: String(track.LayerUuidWithTrack ? Buffer.from(track.LayerUuidWithTrack).toString("hex") : ""),
      cells: curve.keys.map((key) => `${key.tag}@${key.time}`).join(" "),
    });
  }
  await database.close();
  return tracks;
}

const files = [];
for (const arg of process.argv.slice(2)) {
  if (fs.statSync(arg).isDirectory()) {
    for (const entry of fs.readdirSync(arg)) {
      if (/\.clip$/i.test(entry)) files.push(path.join(arg, entry));
    }
  } else {
    files.push(arg);
  }
}

let failed = 0;
let checked = 0;
for (const file of files) {
  const data = Buffer.from(fs.readFileSync(file));
  let before;
  try {
    before = await cellsOf(data);
  } catch {
    continue; // not a Clip Studio document
  }
  if (before.length === 0) {
    console.log(`SKIP ${path.basename(file)}: no cell track`);
    continue;
  }
  try {
    const document = await readClipDocumentFromBytes(data);
    const layers = await readClipLayersFromBytes(data, { includePaper: true });
    const project = clipToProject(document, layers, {});
    const written = await createClipBuffer(project, { name: "round trip", animation: data });
    const after = await cellsOf(Buffer.from(written.buffer));
    const same = before.length === after.length && before.every((one, index) => one.cells === after[index].cells);
    checked += 1;
    console.log(
      `${same ? "OK  " : "DIFF"} ${path.basename(file)}: ${before.length} track(s)` +
        (same ? "" : `\n     before ${JSON.stringify(before)}\n     after  ${JSON.stringify(after)}`),
    );
    if (!same) failed += 1;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${path.basename(file)}: ${error.message}`);
  }
}
console.log(`\n${checked - failed}/${checked} documents keep their cells`);
process.exit(failed ? 1 : 0);
