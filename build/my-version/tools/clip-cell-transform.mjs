/**
 * What the curves of a cell track say about where the cell sits.
 *
 *   node tools/clip-cell-transform.mjs file.clip
 *
 * Every track that carries more than the names of its cells is printed with
 * its curves, and the layer the track hangs on is printed with it: the size
 * of its picture, where the picture sits and where its middle is.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";
import { readActionBlob, readAnimationCurves } from "../public/core/clip-animation.js";

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

const file = process.argv[2];
const bytes = fs.readFileSync(file);
const document = await readClipDocumentFromBytes(new Buffer(bytes));
const rasters = await readClipLayersFromBytes(bytes, { includePaper: true });
const db = await openDatabase(new Buffer(extractDatabase(bytes)));

const externals = new Map();
for (const row of db.prepare("SELECT ExternalID, Offset FROM ExternalChunk").all()) {
  const offset = Number(row.Offset);
  const name = bytes.toString("ascii", offset, offset + 8);
  const size = Number(bytes.readBigUInt64BE(offset + 8));
  if (name === "CHNKExta") {
    externals.set(
      Buffer.from(row.ExternalID).toString("ascii"),
      bytes.subarray(offset + 16, offset + 16 + size),
    );
  }
}

// The uuid of a layer is written with dashes on the layer and without them
// on the track, so the two are compared with the dashes taken out.
const key = (value) => String(value ?? "").replace(/-/g, "").toLowerCase();
const nodes = new Map((document.layerTree ?? []).map((node) => [key(node.uuid), node]));
const rasterOf = new Map(rasters.map((layer) => [Number(layer.id), layer]));

console.log(`canvas ${document.width}x${document.height}, centre ${document.width / 2}, ${document.height / 2}`);

for (const row of db.prepare("SELECT * FROM Track ORDER BY _PW_ID").all()) {
  const blob = externals.get(Buffer.from(row.TrackActionMixer2 ?? []).toString("ascii"));
  const mixer = blob ? readActionBlob(blob) : null;
  const curves = mixer ? readAnimationCurves(mixer) : [];
  const transform = curves.filter((curve) => curve.kind !== "ImageCelName" && curve.kind !== "Opacity");
  if (!transform.length) continue;

  const uuid = Buffer.from(row.LayerUuidWithTrack ?? []).toString("hex");
  const node = nodes.get(key(uuid));
  const raster = node ? rasterOf.get(Number(node.id)) : null;
  console.log(`\ntrack ${row.MainId} kind ${row.TrackKind} layer "${node?.name ?? "?"}"`);
  if (raster) {
    console.log(
      `  picture ${raster.width}x${raster.height} at ${raster.offsetX},${raster.offsetY}` +
        `, middle ${raster.offsetX + raster.width / 2},${raster.offsetY + raster.height / 2}`,
    );
  }
  // The bounds of everything the layer holds, which is the picture of a cell
  // that is a folder.
  if (node) {
    const byId = new Map((document.layerTree ?? []).map((child) => [Number(child.id), child]));
    const kids = [];
    let id = Number(node.firstChildIndex ?? 0);
    const seen = new Set();
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      kids.push(byId.get(id));
      id = Number(byId.get(id).nextIndex ?? 0);
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const child of kids) {
      const childRaster = rasterOf.get(Number(child.id));
      if (!childRaster) continue;
      left = Math.min(left, childRaster.offsetX);
      top = Math.min(top, childRaster.offsetY);
      right = Math.max(right, childRaster.offsetX + childRaster.width);
      bottom = Math.max(bottom, childRaster.offsetY + childRaster.height);
    }
    if (Number.isFinite(left)) {
      console.log(
        `  its ${kids.length} layer(s) span ${left},${top} to ${right},${bottom}` +
          `, middle ${(left + right) / 2},${(top + bottom) / 2}`,
      );
    }
  }
  for (const curve of transform) {
    const fields = curve.fields ?? new Map();
    const frames = fields.get("Frame")?.values ?? [];
    const values = fields.get("Value")?.values ?? [];
    console.log(
      `  ${curve.kind}${curve.axis ? `.${curve.axis}` : ""}: frames [${frames.join(",")}] values [${values.join(",")}]`,
    );
  }
}
await db.close();
