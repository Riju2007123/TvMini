import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

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

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const hex = (value) => {
  if (value == null) return "<null>";
  if (typeof value === "string") return value;
  const bytes = Buffer.from(value);
  return `${bytes.length}b:${bytes.toString("hex")}`;
};
const track = db.prepare("SELECT MainId, LayerUuidWithTrack FROM Track WHERE MainId = 13").get();
console.log("track 13 uuid", hex(track.LayerUuidWithTrack));
for (const row of db.prepare("SELECT MainId, LayerName, LayerFolder, AnimationFolder, LayerUuid FROM Layer").all()) {
  const value = hex(row.LayerUuid);
  if (value.includes("2bcc") || row.AnimationFolder || String(row.LayerName).toLowerCase().includes("folder")) {
    console.log(row.MainId, JSON.stringify(row.LayerName), "folder", row.LayerFolder, "anim", row.AnimationFolder, value);
  }
}
console.log("types:", typeof track.LayerUuidWithTrack, track.LayerUuidWithTrack?.constructor?.name);
await db.close();
