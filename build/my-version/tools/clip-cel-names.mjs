import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";

function extractDatabase(data) {
  let offset = 0x18;
  while (offset + 16 <= data.length) {
    const name = data.toString("ascii", offset, offset + 8);
    const size = Number(data.readBigUInt64BE(offset + 8));
    if (name === "CHNKSQLi") return data.subarray(offset + 16, offset + 16 + size);
    if (!/^[\x20-\xe]{8}$/.test(name) || !Number.isSafeInteger(size) || offset + 16 + size > data.length) return null;
    offset += 16 + size;
  }
  return null;
}

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".clip"));
files.sort();

for (const file of files) {
  let db;
  try {
    const data = fs.readFileSync(path.join(dir, file));
    const raw = extractDatabase(data);
    if (!raw) { console.log(`${file}: no database`); continue; }
    db = await openDatabase(new Buffer(raw));
  } catch (e) {
    console.log(`${file}: ${e.message}`);
    continue;
  }
  try {
    const layers = db.prepare("SELECT MainId, LayerName, LayerType, LayerFolder, AnimationFolder, LayerFirstChildIndex, LayerNextIndex FROM Layer").all();
    const byId = new Map(layers.map((l) => [Number(l.MainId), l]));
    const animFolders = layers.filter((l) => Number(l.AnimationFolder ?? 0) === 1);
    const tl = db.prepare("SELECT FrameRate, StartFrame, EndFrame, CurrentFrame FROM TimeLine").get();
    if (!animFolders.length) {
      const other = layers.filter((l) => Number(l.LayerType) === 1).map((l) => l.LayerName);
      console.log(`${file}: no animation folder | raster layers: ${JSON.stringify(other.slice(0, 12))}${other.length > 12 ? ` (+${other.length - 12})` : ""}`);
      continue;
    }
    for (const folder of animFolders) {
      const kids = [];
      let id = Number(folder.LayerFirstChildIndex);
      while (id) {
        const k = byId.get(id);
        if (!k) break;
        kids.push(`${k.LayerName}${Number(k.LayerFolder) ? "(folder)" : ""}`);
        id = Number(k.LayerNextIndex);
      }
      console.log(`${file}: fps=${tl?.FrameRate} start=${tl?.StartFrame} end=${tl?.EndFrame} cur=${tl?.CurrentFrame}`);
      console.log(`   folder "${folder.LayerName}" cells(${kids.length}): ${kids.slice(0, 24).join(", ")}${kids.length > 24 ? ` … +${kids.length - 24}` : ""}`);
    }
  } catch (e) {
    console.log(`${file}: ${e.message}`);
  } finally {
    await db.close();
  }
}
