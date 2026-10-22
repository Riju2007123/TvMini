/**
 * Every curve of both mixers of every track, with its keys.
 *
 *   node tools/mixer-curves.mjs file.clip [...]
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import {
  readActionBlob, readAnimationCurves, actionProperties,
} from "../public/core/clip-animation.js";
import { locateCurve, documentParts } from "../public/core/clip-mixer.js";

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
      if (!blob) { console.log(`  track ${track.MainId} ${column}: no blob`); continue; }
      const document = readActionBlob(blob);
      let version = "?";
      try { version = readDocumentHeader(document ?? blob)?.version ?? "?"; } catch { }
      try {
        const parts = documentParts(document);
        version = (parts.version ?? version);
        console.log(
          `  track ${track.MainId} ${column}: version ${parts.version}` +
          ` pool="${parts.pool.toString("ascii", 0, Math.min(120, parts.pool.length)).replace(/[^\x20-\x7e]/g, "·")}"` +
          ` body ${parts.body.length}B`,
        );
      } catch (e) {
        console.log(`  track ${track.MainId} ${column}: no parts (${e.message})`);
        continue;
      }
      const curves = readAnimationCurves(document);
      for (const curve of curves) {
        const found = locateCurve(document, curve.kind, curve.axis ?? null);
        const key = curve.axis ? `${curve.kind}/${curve.axis}` : curve.kind;
        let tail = "";
        try {
          for (const [name, field] of found?.fields ?? []) {
            const show = field.values.slice(0, 14).map((v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : String(v)));
            tail += ` ${name}(${field.type})=[${show.join(" ")}]`;
          }
        } catch (e) { tail = ` fields? ${e.message}`; }
        console.log(`      ${key}${tail}`);
      }
      const names = actionProperties(document);
      if (!curves.length) console.log(`      (no key curves; properties: ${names.join(", ") || "none"})`);
    }
  }
  await db.close();
}
