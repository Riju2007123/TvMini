/**
 * Which layer each track drives, and what cells it shows.
 *
 *   node tools/track-info.mjs file.clip
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve } from "../public/core/clip-animation.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    if (!/^[\x20-\x7e]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

const data = fs.readFileSync(process.argv[2]);
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
const layers = new Map();
for (const row of db.prepare("SELECT MainId, LayerName, LayerFolder, AnimationFolder FROM Layer").all()) {
  layers.set(String(row.MainId), row);
}
const uuidOf = new Map();
for (const row of db.prepare("SELECT MainId, LayerUuid FROM Layer").all()) {
  if (row.LayerUuid) uuidOf.set(key(row.LayerUuid), String(row.MainId));
}

for (const track of db.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
  const layerId = uuidOf.get(key(track.LayerUuidWithTrack));
  const layer = layerId ? layers.get(layerId) : null;
  const doc = externals.get(Buffer.from(track.TrackActionMixer2 ?? track.TrackActionMixer).toString("ascii"));
  const curve = doc ? readCelCurve(readActionBlob(doc)) : null;
  console.log(
    `track ${track.MainId} kind ${track.TrackKind} -> layer ${layerId ?? "?"} ` +
    `"${layer?.LayerName ?? "?"}" folder=${layer?.LayerFolder ?? "?"} anim=${layer?.AnimationFolder ?? "?"} ` +
    `cels=${curve ? curve.keys.map((one) => one.tag).join(" ") : "-"}`,
  );
}
await db.close();
