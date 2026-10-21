import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";

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

const file = process.argv[2];
const data = Buffer.from(fs.readFileSync(file));
const db = await openDatabase(new Buffer(extractDatabase(data)));
console.log("layer rows: id name visibility lock opacity folder type");
for (const row of db.prepare(
  "SELECT MainId, LayerName, LayerVisibility, LayerLock, LayerOpacity, LayerFolder, LayerType, AnimationFolder FROM Layer ORDER BY MainId",
).all()) {
  if ([3, 17, 22, 66, 4, 5, 75].includes(Number(row.MainId))) {
    console.log(" ", row.MainId, JSON.stringify(row.LayerName), "vis", row.LayerVisibility, "lock", row.LayerLock,
      "op", row.LayerOpacity, "folder", row.LayerFolder, "type", row.LayerType, "anim", row.AnimationFolder ?? "");
  }
}
await db.close();

const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});
console.log("\nproject layers: name visible opacity pre type");
for (const layer of project.layers) {
  if (["Folder 2", "Folder 1", "Animation folder", "Layer 10", "1a"].includes(layer.name)) {
    console.log(" ", JSON.stringify(layer.name), "visible", layer.visible, "opacity", layer.opacity,
      "pre", layer.preBehavior, "type", layer.type, "drawings", layer.drawings.length);
  }
}
