/**
 * Round-trip the action document of every track of a .clip.
 *
 *   node tools/mixer-roundtrip.mjs file.clip [...]
 *
 * Parses each document, writes it back from its parts, and compares the two
 * byte for byte. A document that survives unchanged proves that the pool, the
 * word after it, the body and the CRC-32 are understood; only then is it safe
 * to change the part inside it.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readCelCurve } from "../public/core/clip-animation.js";
import {
  rebuildDocument,
  encodeMixerPayload,
  decodeMixerPayload,
  replaceCurve,
  celCurveFields,
  withStrings,
} from "../public/core/clip-mixer.js";

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

let bad = 0;
for (const file of process.argv.slice(2)) {
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
  const tracks = db.prepare("SELECT MainId, TrackActionMixer, TrackActionMixer2 FROM Track ORDER BY MainId").all();
  await db.close();

  console.log(`\n=== ${file}`);
  for (const track of tracks) {
    for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
      const id = Buffer.from(track[column]).toString("ascii");
      const payload = externals.get(id);
      if (!payload) continue;
      const doc = readActionBlob(payload);
      if (!doc) continue;
      const rebuilt = rebuildDocument(doc);
      const same = Buffer.compare(Buffer.from(doc.raw), rebuilt) === 0;
      if (!same) bad += 1;
      // And the payload itself, through the external chunk encoding.
      const encoded = encodeMixerPayload(doc.raw, id);
      const back = decodeMixerPayload(encoded);
      const payloadSame = back && Buffer.compare(Buffer.from(back.raw), Buffer.from(doc.raw)) === 0;

      // Change the cell curve: same keys, then one more, then one fewer.
      let edit = "no cels";
      const curve = readCelCurve(doc);
      if (curve) {
        const pool = withStrings(doc.pool, curve.keys.map((key) => key.tag));
        const fields = celCurveFields(curve.keys, pool);
        const once = replaceCurve(doc, { kind: "ImageCelName", fields });
        const again = readCelCurve(readActionBlob(encodeMixerPayload(once, id)));
        const sameKeys = again && JSON.stringify(again.keys) === JSON.stringify(curve.keys);
        const more = replaceCurve(doc, {
          kind: "ImageCelName",
          fields: celCurveFields([...curve.keys, { ...curve.keys.at(-1), time: curve.keys.at(-1).time + 10 }], pool),
        });
        const moreKeys = readCelCurve(readActionBlob(encodeMixerPayload(more, id)));
        const fewer = replaceCurve(doc, {
          kind: "ImageCelName",
          fields: celCurveFields(curve.keys.slice(0, -1), pool),
        });
        const fewerKeys = readCelCurve(readActionBlob(encodeMixerPayload(fewer, id)));
        edit =
          `same=${sameKeys ? "ok" : "BAD"} ` +
          `+1=${moreKeys?.keys.length === curve.keys.length + 1 ? "ok" : "BAD"} ` +
          `-1=${fewerKeys?.keys.length === curve.keys.length - 1 ? "ok" : "BAD"}`;
        if (!sameKeys || moreKeys?.keys.length !== curve.keys.length + 1 || fewerKeys?.keys.length !== curve.keys.length - 1) {
          bad += 1;
        }
      }
      console.log(
        `  track ${track.MainId} ${column}: ${doc.raw.length} bytes ` +
        `rebuild=${same ? "SAME" : "DIFFERENT"} payload=${payloadSame ? "SAME" : "DIFFERENT"} ` +
        `edit ${edit}`,
      );
    }
  }
}
process.exit(bad ? 1 : 0);
