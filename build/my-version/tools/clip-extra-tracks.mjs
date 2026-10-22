/**
 * The tracks of a document that carry something other than cells.
 *
 *   node tools/clip-extra-tracks.mjs file.clip
 *
 * Every track is printed with its kind, the layer it hangs on and the curves
 * of its mixer, so the tracks that are not cell tracks - the ones the
 * writer does not write yet - can be seen.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readAnimationCurves } from "../public/core/clip-animation.js";
import { readTrackRange } from "../public/core/clip-animation.js";

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

const externalsOf = (data, db) => {
  const externals = new Map();
  for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
    const offset = Number(row.Offset);
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKExta") {
      externals.set(
        Buffer.from(row.ExternalID).toString("ascii"),
        data.subarray(offset + 16, offset + 16 + size),
      );
    }
  }
  return externals;
};

const data = fs.readFileSync(process.argv[2]);
const db = await openDatabase(new Buffer(extractDatabase(data)));
const externals = externalsOf(data, db);
const layers = new Map(
  db.prepare("SELECT MainId, LayerName, AnimationFolder FROM Layer").all().map((row) => [Number(row.MainId), row]),
);
const uuids = new Map(
  db.prepare("SELECT MainId, LayerUuid FROM Layer").all().map((row) => [Number(row.MainId), Buffer.from(row.LayerUuid).toString("hex")]),
);

for (const track of db.prepare("SELECT * FROM Track ORDER BY _PW_ID").all()) {
  const uuid = Buffer.from(track.LayerUuidWithTrack ?? []).toString("hex");
  const layer = [...uuids.entries()].find(([, value]) => value === uuid);
  const name = layer ? (layers.get(layer[0])?.LayerName ?? "?") : "?";
  const folder = layer ? layers.get(layer[0])?.AnimationFolder : null;
  const parts = [];
  for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
    const blob = externals.get(Buffer.from(track[column] ?? []).toString("ascii"));
    const document = blob ? readActionBlob(blob) : null;
    if (!document) {
      parts.push(`${column}: -`);
      continue;
    }
    const range = readTrackRange(document);
    const curves = readAnimationCurves(document);
    const description = curves.length
      ? curves
          .map((curve) => {
            const fields = [...(curve.fields ?? new Map())]
              .map(([name, field]) => `${name}=[${(field.values ?? []).join(",")}]`)
              .join(" ");
            return `${curve.kind}${curve.axis ? `.${curve.axis}` : ""} ${fields}`;
          })
          .join(" | ")
      : "(no curves)";
    parts.push(`${column}: range ${range ? `${range.start}..${range.end}` : "-"} ${description}`);
  }
  console.log(
    `track ${track.MainId} kind ${track.TrackKind} flags ${track.TrackOptionFlag} layer "${name}" anim=${folder ?? "-"}`,
  );
  for (const part of parts) console.log(`   ${part}`);
}
await db.close();
