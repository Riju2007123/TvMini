// Dump the camera track (kind 2005) of a .clip: its layer row, its track row,
// and every curve its mixer carries, with the axis, the field types and the
// first few values of each. Used to know exactly what a camera writer must emit.
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

function chunksOf(data) {
  const out = [];
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    out.push({ name, payload: data.subarray(offset + 16, offset + 16 + size) });
    offset += 16 + size;
  }
  return out;
}

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const container = chunksOf(data);

const cameraLayer = db.prepare("SELECT * FROM Layer WHERE LayerType = 512").get();
console.log("=== camera layer (LayerType 512) ===");
if (cameraLayer) {
  for (const [k, v] of Object.entries(cameraLayer)) {
    if (v === null || v === undefined) continue;
    console.log(`  ${k} = ${v instanceof Uint8Array ? `blob(${v.length}):${Buffer.from(v).toString("hex")}` : v}`);
  }
} else console.log("  (none)");

const cameraTrack = db.prepare("SELECT * FROM Track WHERE TrackKind = 2005").get();
console.log("\n=== camera track (TrackKind 2005) ===");
if (cameraTrack) {
  for (const [k, v] of Object.entries(cameraTrack)) {
    if (v === null || v === undefined) continue;
    console.log(`  ${k} = ${v instanceof Uint8Array ? `blob(${v.length}):${Buffer.from(v).toString("ascii")}` : v}`);
  }
} else console.log("  (none)");

const blobOf = (value) => {
  if (!value) return null;
  const id = Buffer.from(value).toString("ascii");
  const chunk = container.find((c) => c.name === "CHNKExta" && c.payload.toString("ascii", 8, 48) === id);
  return chunk ? readActionBlob(chunk.payload) : null;
};

for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
  if (!cameraTrack) break;
  const doc = blobOf(cameraTrack[column]);
  console.log(`\n=== ${column} ===`);
  if (!doc) { console.log("  (no blob)"); continue; }
  console.log(`  version=${doc.version} codec=${doc.codec} pool=${doc.pool.length} body=${doc.body.length}`);
  const curves = readAnimationCurves(doc);
  console.log(`  curves: ${curves.length}`);
  for (const curve of curves) {
    console.log(`  - kind=${curve.kind} axis=${JSON.stringify(curve.axis)} props=${JSON.stringify([...curve.props])}`);
    for (const [name, field] of curve.fields) {
      const preview = field.values.slice(0, 6);
      console.log(`      ${name} [${field.type}] count=${field.values.length} first=${JSON.stringify(preview)}`);
    }
  }
}
await db.close();
