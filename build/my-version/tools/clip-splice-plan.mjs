/**
 * Splice a new cell plan into a real Clip Studio document.
 *
 *   node tools/clip-splice-plan.mjs in.clip out.clip
 *
 * Everything but the cell curve stays as it is: the same document, the same
 * layers, the same tracks, the same blobs. Only the plan of the cells - the
 * frame each cell starts on - is written anew, in both mixers of the track
 * that carries the cells.
 *
 * It is the control for an exported file: when the control plays and the
 * export does not, the difference is in the file that was written, and when
 * neither plays, the difference is in the plan.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { parseClipContainer } from "../public/core/clip.js";
import { readActionBlob } from "../public/core/clip-animation.js";
import { deflateSync } from "../public/core/zlib.js";
import { locateCurve, spliceCurve } from "../public/core/clip-mixer.js";

const source = process.argv[2];
const target = process.argv[3];
if (!source || !target) {
  console.log("usage: node tools/clip-splice-plan.mjs in.clip out.clip");
  process.exit(1);
}

const data = fs.readFileSync(source);
const container = parseClipContainer(data);
const database = await openDatabase(new Buffer(container.database));

// The track that carries the cells, and the blobs of its two mixers.
const track = database.prepare("SELECT * FROM Track WHERE TrackKind = 2000 ORDER BY MainId LIMIT 1").get();
if (!track) throw new Error("the document has no cell track");

const externals = new Map();
for (const row of database.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  externals.set(Buffer.from(row.ExternalID).toString("ascii"), Number(row.Offset));
}

// The cells the document already has, and the frames they are given.
// The names and the values of the cells stay as they are; only the times
// move, so that the document is changed in one thing only.
const names = ["1", "1a", "2", "2a", "3", "4"];
const frames = [1, 21, 41, 61, 81, 101];
const frameRate = 24;

const replacements = new Map();
for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
  const id = Buffer.from(track[column]).toString("ascii");
  const at = externals.get(id);
  if (at === undefined) throw new Error(`the ${column} is not in the file`);
  const size = Number(data.readBigUInt64BE(at + 8));
  const blob = data.subarray(at + 16, at + 16 + size);
  const document = readActionBlob(blob);
  if (!document) throw new Error(`the ${column} is not an action document`);

  // The curve of the document, and the same fields with new times: the
  // names, the values, the slopes and the way the cells are held stay as
  // they are.
  const found = locateCurve(document, "ImageCelName");
  if (!found) throw new Error(`the ${column} holds no cell curve`);
  const fields = [];
  for (const [name, field] of found.fields) {
    const values =
      name === "Frame"
        ? frames.map((frame) => ((frame - 1) * 60) / frameRate)
        : [...field.values];
    fields.push({ name, type: field.type, values });
  }
  const spliced = spliceCurve(document, { kind: "ImageCelName", fields });

  // The blob keeps its id, so the track still points at it.
  const head = Buffer.from(blob.subarray(0, 60));
  const stream = deflateSync(spliced);
  head.writeBigUInt64BE(BigInt(4 + stream.length), 48);
  head.writeUInt32LE(stream.length, 56);
  replacements.set(at, Buffer.concat([head, stream]));
  console.log(
    `${column}: ${blob.length} -> ${60 + stream.length} bytes, frames ${JSON.stringify(frames)}`,
  );
}

// The document is written again with the same chunks in the same order, the
// new blobs in place of the old ones, and the offsets of the table
// rewritten.
const headSize = container.chunks.find((chunk) => chunk.name === "CHNKHead").size;
const chunks = container.chunks.map((chunk) => {
  const replacement = replacements.get(chunk.headerOffset);
  return {
    name: chunk.name,
    payload: replacement ? Buffer.from(replacement) : Buffer.from(chunk.payload),
  };
});

// Where every chunk ends up in the new file. The head chunk follows the
// 24 byte container header, and every chunk is a name, a size and a body.
let position = 24;
const offsets = new Map();
let databaseOffset = 0;
for (const chunk of chunks) {
  if (chunk.name === "CHNKExta") {
    offsets.set(chunk.payload.toString("ascii", 8, 48), position);
  }
  if (chunk.name === "CHNKSQLi") databaseOffset = position;
  position += 16 + chunk.payload.length;
}

// The head says where the database is.
const head = chunks.find((chunk) => chunk.name === "CHNKHead");
head.payload.writeBigUInt64BE(BigInt(databaseOffset), 8);

for (const row of database.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  const id = Buffer.from(row.ExternalID).toString("ascii");
  const at = offsets.get(id);
  if (at !== undefined && Number(row.Offset) !== at) {
    database.prepare("UPDATE ExternalChunk SET Offset = ? WHERE ExternalID = ?").run(at, row.ExternalID);
  }
}
const databaseBytes = Buffer.from(await database.export());
await database.close();

// The database is written last, so its size does not move anything.
chunks[chunks.findIndex((chunk) => chunk.name === "CHNKSQLi")].payload = databaseBytes;

const body = [];
for (const chunk of chunks) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(chunk.payload.length), 0);
  body.push(Buffer.from(chunk.name, "ascii"), size, chunk.payload);
}
const header = Buffer.alloc(24);
header.write("CSFCHUNK", 0, "ascii");
header.writeBigUInt64BE(BigInt(24 + Buffer.concat(body).length), 8);
header.writeBigUInt64BE(BigInt(24), 16);
const output = Buffer.concat([header, ...body]);
fs.writeFileSync(target, output);
console.log(`wrote ${target} (${output.length} bytes, database at ${databaseOffset})`);
