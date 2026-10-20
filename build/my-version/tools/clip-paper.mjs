import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { openDatabase } from "../public/core/sqlite.js";
import { parseAttribute, splitAttribute } from "../public/core/clip-blocks.js";

const path = process.argv[2];
const data = fs.readFileSync(path);
let offset = 0x18;
let dbBytes = null;
while (offset + 16 <= data.length) {
  const name = data.toString("ascii", offset, offset + 8);
  const size = Number(data.readBigUInt64BE(offset + 8));
  if (name === "CHNKSQLi") { dbBytes = data.subarray(offset + 16, offset + 16 + size); break; }
  offset += 16 + size;
}
const db = await openDatabase(new Buffer(dbBytes));

for (const row of db.prepare("SELECT MainId, LayerName, LayerType, DrawToRenderOffscreenType, DrawColorMainRed, DrawColorMainGreen, DrawColorMainBlue, DrawColorEnable, LayerRenderMipmap FROM Layer ORDER BY MainId").all()) {
  console.log(`layer #${row.MainId} "${row.LayerName}" type=${row.LayerType} drawToRenderOffscreenType=${row.DrawToRenderOffscreenType} drawColor=(${row.DrawColorMainRed},${row.DrawColorMainGreen},${row.DrawColorMainBlue}) enable=${row.DrawColorEnable}`);
}

console.log("\n-- paper layer init colour --");
const paper = db.prepare("SELECT MainId, LayerRenderMipmap FROM Layer WHERE LayerType = 1584 ORDER BY MainId LIMIT 1").get();
if (paper) {
  const mip = db.prepare("SELECT BaseMipmapInfo FROM Mipmap WHERE MainId = ?").get(paper.LayerRenderMipmap);
  const info = db.prepare("SELECT Offscreen FROM MipmapInfo WHERE MainId = ?").get(mip.BaseMipmapInfo);
  const off = db.prepare("SELECT Attribute, BlockData FROM Offscreen WHERE MainId = ?").get(info.Offscreen);
  const attr = Buffer.from(off.Attribute);
  const { sections } = splitAttribute(attr);
  const init = sections[1];
  console.log("  initColor section length", init.length);
  console.log("  hex:", init.toString("hex"));
  for (const o of [22, 26, 30, 34, 38, 42]) {
    if (o + 4 <= init.length) console.log(`  u32 @${o} = ${init.readUInt32BE(o)}`);
  }
  const a = parseAttribute(attr);
  console.log("  parsed:", JSON.stringify({ width: a.width, height: a.height, colorMode: a.colorMode, numChannels: a.numChannels, bitDepth: a.bitDepth, hasInitColor: a.hasInitColor, initPacked: a.initPacked?.toString(16), extraColors: a.extraColors, initChannels: a.initChannels }));
}

console.log("\n-- Project paper settings --");
const p = db.prepare("SELECT DefaultPageUsePaper, DefaultPagePaperRed, DefaultPagePaperGreen, DefaultPagePaperBlue, DefaultPageColorType FROM Project LIMIT 1").get();
console.log(" ", JSON.stringify(p));
await db.close();
