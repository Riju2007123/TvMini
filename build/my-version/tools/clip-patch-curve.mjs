/**
 * Rewrite the cell order of one track of a .clip and write a new file.
 *
 *   node tools/clip-patch-curve.mjs source.clip out.clip <trackId> [reverse]
 *
 * This is the smallest end-to-end exercise of the writer: one curve inside
 * one mixer is replaced, the external chunk that carries it is rebuilt, the
 * offsets in `ExternalChunk` are recomputed, and the container is put back
 * together. Nothing else in the file is touched.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve } from "../public/core/clip-animation.js";
import {
  celCurveFields,
  encodeMixerPayload,
  mixerColumnSize,
  replaceCurve,
  withStrings,
} from "../public/core/clip-mixer.js";

function parseChunks(data) {
  const chunks = [];
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    chunks.push({ name, size, body: data.subarray(offset + 16, offset + 16 + size) });
    offset += 16 + size;
  }
  return chunks;
}

/** A chunk: its name, and the bytes after the size word. */
function chunkOf(name, body) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(body.length), 0);
  return Buffer.concat([Buffer.from(name, "ascii"), size, body]);
}

const [source, target, trackText, mode = "reverse"] = process.argv.slice(2);
if (!source || !target || !trackText) {
  console.error("usage: node tools/clip-patch-curve.mjs source.clip out.clip <trackId> [reverse]");
  process.exit(2);
}
const trackId = Number(trackText);

const data = fs.readFileSync(source);
const chunks = parseChunks(data);
const head = chunks.find((chunk) => chunk.name === "CHNKHead");
const databaseChunk = chunks.find((chunk) => chunk.name === "CHNKSQLi");
const externals = chunks.filter((chunk) => chunk.name === "CHNKExta");
if (!head || !databaseChunk) throw new Error("the file has no head or database chunk");

const database = await openDatabase(new Buffer(databaseChunk.body));

// Every external chunk body is [u64 40][id][u64 payloadLength][payload],
// which is the blob `readActionBlob` reads whole.
const payloads = new Map();
for (const chunk of externals) {
  const id = chunk.body.toString("ascii", 8, 48);
  payloads.set(id, chunk.body);
}

const row = database.prepare("SELECT * FROM Track WHERE MainId = ?").get(trackId);
if (!row) throw new Error(`the file has no track ${trackId}`);
const id = Buffer.from(row.TrackActionMixer2).toString("ascii");
const blob = payloads.get(id);
if (!blob) throw new Error(`the track's mixer ${id} is not in the file`);

const document = readActionBlob(blob);
const curve = readCelCurve(document);
if (!curve) throw new Error("the track has no cell curve");
console.log(`track ${trackId}: ${curve.keys.length} keys, tags ${curve.keys.map((key) => key.tag).join(" ")}`);

const tags = curve.keys.map((key) => key.tag);
const nextTags = mode === "reverse" ? [...tags].reverse() : tags;
const pool = withStrings(document.pool, nextTags);
const keys = curve.keys.map((key, index) => ({ ...key, tag: nextTags[index] }));
const updated = replaceCurve(document, { kind: "ImageCelName", fields: celCurveFields(keys, pool) });
payloads.set(id, encodeMixerPayload(updated, id));
console.log(`new tags ${nextTags.join(" ")}; document ${document.raw.length} -> ${updated.length} bytes`);

// Lay the file out again, in the order the chunks already had.
let position = 0x18 + 16 + head.body.length;
const placed = [];
for (const chunk of externals) {
  const chunkId = chunk.body.toString("ascii", 8, 48);
  const body = payloads.get(chunkId);
  placed.push({ id: chunkId, body, offset: position });
  position += 16 + body.length;
}
const binarySectionSize = position;

database.prepare("DELETE FROM ExternalChunk").run();
for (const entry of placed) {
  database.prepare("INSERT INTO ExternalChunk (ExternalID, Offset) VALUES (?, ?)").run(entry.id, entry.offset);
}
database
  .prepare("UPDATE Track SET TrackActionMixer2Size = ? WHERE MainId = ?")
  .run(mixerColumnSize(updated), trackId);

const sqlite = Buffer.from(await database.export());
await database.close();

const headBody = Buffer.from(head.body);
headBody.writeBigUInt64BE(BigInt(binarySectionSize), 8);

const body = Buffer.concat([
  chunkOf("CHNKHead", headBody),
  ...placed.map((entry) => chunkOf("CHNKExta", entry.body)),
  chunkOf("CHNKSQLi", sqlite),
  chunkOf("CHNKFoot", Buffer.alloc(0)),
]);

const header = Buffer.alloc(0x18);
header.write("CSFCHUNK", 0, "ascii");
header.writeBigUInt64BE(BigInt(0x18 + body.length), 8);
header.writeBigUInt64BE(BigInt(0x18), 16);

const output = Buffer.concat([header, body]);
fs.writeFileSync(target, output);
console.log(`wrote ${target} (${output.length} bytes)`);
