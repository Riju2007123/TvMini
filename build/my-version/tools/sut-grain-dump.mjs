/**
 * Take the pictures out of a Clip Studio Paint brush, so they can be looked at.
 *
 *   node tools/sut-grain-dump.mjs "brush.sut" "C:\out\folder"
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTar } from "../public/core/tar.js";
import { decodePng } from "../public/core/png.js";
import { brushPngFromBytes } from "../public/core/brush.js";

const [file, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT FileData FROM MaterialFile").all();

/** The words a material says about itself. */
function words(data) {
  const set = new Set();
  for (const entry of readTar(data)) {
    if (!entry.name.endsWith(".xml")) continue;
    for (const match of entry.data.toString("utf8").matchAll(/<data id="">([^<]+)<\/data>/g)) {
      set.add(match[1]);
    }
  }
  return [...set];
}

for (const [index, material] of materials.entries()) {
  const entries = readTar(material.FileData);
  const tag = words(material.FileData).includes("PaperTexture") ? "grain" : "shape";
  for (const entry of entries) {
    if (!entry.name.includes("thumbnail")) continue;
    const png = brushPngFromBytes(entry.data);
    if (!png) continue;
    const name = `${tag}-${index}-thumbnail.png`;
    writeFileSync(join(out, name), png);
    console.log(`${name}: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    try {
      const image = decodePng(png);
      // How bright the picture is, and how much of it is see-through.
      let sum = 0;
      let count = 0;
      let clear = 0;
      for (let at = 0; at < image.data.length; at += 4) {
        sum += image.data[at];
        if (image.data[at + 3] < 8) clear += 1;
        count += 1;
      }
      console.log(
        `  mean red ${(sum / count).toFixed(1)}, see-through ${((clear / count) * 100).toFixed(1)}%`,
      );
    } catch (error) {
      console.log(`  cannot read: ${error.message}`);
    }
  }
  for (const entry of entries) {
    if (!entry.name.startsWith("data/")) continue;
    try {
      const image = decodePng(entry.data);
      let clear = 0;
      let sum = 0;
      for (let at = 0; at < image.data.length; at += 4) {
        sum += image.data[at];
        if (image.data[at + 3] < 8) clear += 1;
      }
      const count = image.data.length / 4;
      console.log(
        `  ${entry.name}: readable ${image.width}x${image.height} mean red ${(sum / count).toFixed(1)} clear ${((clear / count) * 100).toFixed(1)}%`,
      );
      writeFileSync(join(out, `${tag}-${index}-${entry.name.replace(/\W+/g, "_")}.png`), entry.data);
    } catch (error) {
      console.log(`  ${entry.name}: cannot read (${error.message})`);
    }
  }
}
db.close();
