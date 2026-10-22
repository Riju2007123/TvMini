import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve, readAnimationCurves } from "../public/core/clip-animation.js";
import { locateCurve } from "../public/core/clip-mixer.js";

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
for (const track of db.prepare("SELECT * FROM Track WHERE TrackKind = 2000").all()) {
  for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
    const blob = externals.get(Buffer.from(track[column] ?? []).toString("ascii"));
    const document = blob ? readActionBlob(blob) : null;
    const audit = readCelCurve(document);
    const located = locateCurve(document ?? {}, "ImageCelName");
    console.log(column);
    console.log("   readCelCurve keys:", audit?.keys.map((k) => `${k.time}(${k.tag})`).join(" "));
    console.log("   curves found by scan:", readAnimationCurves(document).length);
    console.log("   locateCurve Frame:", located ? Array.from(located.fields.get("Frame").values).join(" ") : "none");
    console.log(
      "   ImageCelName pool idx", document.pool.indexOf("ImageCelName"),
      "| FCurve idx", document.pool.indexOf("FCurve"),
    );
  }
}
await db.close();
