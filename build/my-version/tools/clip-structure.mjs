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

function idText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return Buffer.from(value).toString("ascii");
}

const path = process.argv[2];
const data = fs.readFileSync(path);
const db = await openDatabase(new Buffer(extractDatabase(data)));

const blobIds = new Set(db.prepare("SELECT ExternalID FROM ExternalChunk").all().map((r) => idText(r.ExternalID)));
const offscreens = new Map(db.prepare("SELECT MainId, LayerId, BlockData FROM Offscreen").all().map((r) => [Number(r.MainId), r]));
const mipmaps = new Map(db.prepare("SELECT MainId, MipmapCount, BaseMipmapInfo FROM Mipmap").all().map((r) => [Number(r.MainId), r]));
const infos = new Map(db.prepare("SELECT MainId, Offscreen, NextIndex FROM MipmapInfo").all().map((r) => [Number(r.MainId), r]));

console.log(`blobs in file: ${blobIds.size}`);
console.log("\n== LAYERS ==");
for (const l of db.prepare("SELECT MainId, LayerName, LayerType, LayerFolder, LayerVisibility, LayerOpacity, LayerRenderMipmap, LayerRenderThumbnail, LayerFirstChildIndex, LayerNextIndex FROM Layer ORDER BY MainId").all()) {
  console.log(`  #${l.MainId} "${l.LayerName}" type=${l.LayerType} folder=${l.LayerFolder} vis=${l.LayerVisibility} op=${l.LayerOpacity} mip=${l.LayerRenderMipmap} thumb=${l.LayerRenderThumbnail} first=${l.LayerFirstChildIndex} next=${l.LayerNextIndex}`);
  const mm = mipmaps.get(Number(l.LayerRenderMipmap) || 0);
  if (!mm) { console.log("      (no mipmap)"); continue; }
  console.log(`      mipmap #${mm.MainId} count=${mm.MipmapCount}`);
  let node = Number(mm.BaseMipmapInfo) || 0;
  let depth = 0;
  while (node && depth < 20) {
    const info = infos.get(node);
    if (!info) { console.log(`      info #${node} MISSING`); break; }
    const off = offscreens.get(Number(info.Offscreen) || 0);
    const bid = idText(off?.BlockData);
    console.log(`      info #${node} scale=? off=${info.Offscreen} next=${info.NextIndex} blob=${bid ? (blobIds.has(bid) ? "PRESENT" : "absent") : "none"} ${bid ?? ""}`);
    node = Number(info.NextIndex) || 0;
    depth++;
  }
}

console.log("\n== ORPHAN/UNUSED OFFSCREENS ==");
for (const [id, o] of offscreens) {
  const bid = idText(o.BlockData);
  const has = bid ? blobIds.has(bid) : false;
  console.log(`  off #${id} layerId=${o.LayerId} blob=${has ? "PRESENT" : "absent"} ${bid ?? ""}`);
}
await db.close();
