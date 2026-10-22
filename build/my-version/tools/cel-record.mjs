/**
 * The ImageCelName record of every mixer, read through locateCurve, which
 * understands the old 0100 flavour as well as the new one.
 *
 *   node tools/cel-record.mjs file.clip [...]
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob } from "../public/core/clip-animation.js";
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

for (const file of process.argv.slice(2)) {
  console.log("============ " + file);
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
  for (const track of db.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
    for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
      const blob = externals.get(Buffer.from(track[column] ?? []).toString("ascii"));
      if (!blob) continue;
      const document = readActionBlob(blob);
      const found = locateCurve(document, "ImageCelName");
      if (!found) { console.log(`  track ${track.MainId} ${column}: no ImageCelName record`); continue; }
      const show = (field) => field.values
        .map((value) => (field.type === "String[]" ? `"${document.pool[value]}"` :
          typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : value))
        .join(" ");
      console.log(`  track ${track.MainId} ${column}: meta=${found.meta}`);
      for (const [name, field] of found.fields) {
        console.log(`      ${name}(${field.type},${field.values.length}) = ${show(field)}`);
      }
      for (const [key, value] of found.props) console.log(`      prop ${key} = "${value}"`);
    }
  }
  await db.close();
}
