/**
 * What the tracks of a .clip animate, and what the layers are made of.
 *
 *   node tools/clip-content-probe.mjs file.clip [...]
 *
 * The curve kinds say which properties a track animates, and the layer types
 * say whether the artwork is a raster or a vector. Both say how much of a
 * document the reader and the writer keep.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readActionBlob, readAnimationCurves, actionProperties } from "../public/core/clip-animation.js";

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

  const kinds = new Map();
  for (const track of db.prepare("SELECT * FROM Track ORDER BY MainId").all()) {
    for (const column of ["TrackActionMixer", "TrackActionMixer2"]) {
      const blob = externals.get(Buffer.from(track[column] ?? []).toString("ascii"));
      const document = blob ? readActionBlob(blob) : null;
      if (!document) continue;
      for (const curve of readAnimationCurves(document)) {
        const key = `${curve.kind}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      const names = actionProperties(document);
      if (names.length) {
        const key = `properties: ${names.join(", ")}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
    }
  }

  const layers = db.prepare("SELECT LayerType, COUNT(*) AS n FROM Layer GROUP BY LayerType ORDER BY LayerType").all();
  const vectors = db.prepare("SELECT COUNT(*) AS n FROM Layer WHERE LayerType = 2").get();
  console.log(`=== ${file}`);
  console.log("  layer types:", layers.map((row) => `${row.LayerType}x${row.n}`).join(" "));
  console.log("  curves:", [...kinds.entries()].map(([key, n]) => `${key}${n > 1 ? ` (${n})` : ""}`).join(" | ") || "none");
  await db.close();
}
