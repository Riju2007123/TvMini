/**
 * Look at the materials of every brush on this machine.
 *
 * Prints, for each material, the words its XML uses and what the thumbnail
 * holds, so that the material of the grain can be told from the material of
 * the tip across many brushes.
 *
 *   node tools/sut-grain-survey.mjs "C:\Users\MK\Documents" "H:\Brushes"
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readTar } from "../public/core/tar.js";
import { decodePng } from "../public/core/png.js";
import { brushPngFromBytes } from "../public/core/brush.js";

/** Every .sut file in a folder. */
function brushes(folder) {
  try {
    return readdirSync(folder)
      .filter((name) => name.toLowerCase().endsWith(".sut"))
      .map((name) => join(folder, name));
  } catch {
    return [];
  }
}

for (const file of process.argv.slice(2).flatMap(brushes)) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    console.log(`${file}: cannot open`);
    continue;
  }
  const name = db.prepare("SELECT NodeName FROM Node LIMIT 1").get()?.NodeName;
  const variant = db.prepare("SELECT * FROM Variant WHERE VariantID = (SELECT NodeVariantID FROM Node LIMIT 1)").get()
    ?? db.prepare("SELECT * FROM Variant ORDER BY VariantID LIMIT 1").get() ?? {};
  const settings = [
    `density=${variant.TextureDensity}`,
    `scale=${variant.TextureScale2}`,
    `rotate=${variant.TextureRotate}`,
    `mode=${variant.TextureCompositeMode}`,
    `reverse=${variant.TextureReverseDensity}`,
    `forPlot=${variant.TextureForPlot}`,
    `hardness=${variant.BrushHardness}`,
    `thickness=${variant.BrushThickness}`,
    `flow=${variant.BrushFlow}`,
    `interval=${variant.BrushInterval}`,
    `pattern=${variant.BrushUsePatternImage}`,
  ].join(" ");

  const materials = (() => {
    try {
      return db.prepare("SELECT FileData FROM MaterialFile").all();
    } catch {
      return [];
    }
  })();

  const parts = [];
  for (const material of materials) {
    let entries;
    try {
      entries = readTar(material.FileData);
    } catch {
      continue;
    }
    const words = new Set();
    for (const entry of entries) {
      if (!entry.name.endsWith(".xml")) continue;
      for (const match of entry.data.toString("utf8").matchAll(/<data id="">([^<]+)<\/data>/g)) {
        words.add(match[1]);
      }
    }
    const tag = words.has("PaperTexture") ? "GRAIN" : words.has("BrushPattern") ? "shape" : "?";
    for (const entry of entries) {
      if (!entry.name.includes("thumbnail")) continue;
      const png = brushPngFromBytes(entry.data);
      if (!png) continue;
      const image = decodePng(png);
      let minA = 255;
      let maxA = 0;
      let sumA = 0;
      let colour = 0;
      for (let at = 0; at < image.data.length; at += 4) {
        minA = Math.min(minA, image.data[at + 3]);
        maxA = Math.max(maxA, image.data[at + 3]);
        sumA += image.data[at + 3];
        if (image.data[at] || image.data[at + 1] || image.data[at + 2]) colour += 1;
      }
      const count = image.data.length / 4;
      parts.push(
        `${tag} ${image.width}x${image.height} a=${minA}..${maxA} mean=${(sumA / count).toFixed(0)} rgb=${((colour / count) * 100).toFixed(0)}%`,
      );
    }
  }
  console.log(`\n${name}  (${file})`);
  console.log(`  ${settings}`);
  for (const part of parts) console.log(`  ${part}`);
  db.close();
}
