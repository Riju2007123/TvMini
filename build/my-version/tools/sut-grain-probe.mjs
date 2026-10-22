/**
 * Look at the grain of a Clip Studio Paint brush.
 *
 * Clip Studio Paint calls the grain of a brush its "texture". This prints the
 * settings that say how the grain is used, and the materials in the file with
 * the words their XML uses, so that the material of the grain can be told
 * apart from the material of the tip.
 *
 *   node tools/sut-grain-probe.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";
import { readTar } from "../public/core/tar.js";
import { decodePng } from "../public/core/png.js";
import { brushPngFromBytes } from "../public/core/brush.js";

const WANTED = /^(Texture|Brush(Type|Use(Pattern|WaterColor|Spray)|Thickness|Flow|Hardness|Interval|Adjust|InOut|UseIn|InLength|InRatio|UseOut|OutLength|OutRatio)|Opacity|AntiAlias|CompositeMode|Stickness|Flicker)/;

for (const file of process.argv.slice(2)) {
  const db = new DatabaseSync(file, { readOnly: true });
  console.log(`\n=== ${file} ===`);
  const node = db.prepare("SELECT NodeName FROM Node LIMIT 1").get();
  console.log("name:", node?.NodeName);

  const variant = db.prepare("SELECT * FROM Variant WHERE VariantID = (SELECT NodeVariantID FROM Node LIMIT 1)").get()
    ?? db.prepare("SELECT * FROM Variant ORDER BY VariantID LIMIT 1").get();
  const settings = {};
  for (const [key, value] of Object.entries(variant ?? {})) {
    if (!WANTED.test(key)) continue;
    if (value === null) continue;
    if (value instanceof Uint8Array) {
      settings[key] = `<${value.length} bytes>`;
      continue;
    }
    settings[key] = value;
  }
  console.log("settings:", JSON.stringify(settings, null, 1));

  let materials = [];
  try {
    materials = db.prepare("SELECT FileData FROM MaterialFile").all();
  } catch {
    console.log("no MaterialFile table");
  }
  console.log("materials:", materials.length);
  for (const [index, material] of materials.entries()) {
    let files = [];
    try {
      files = readTar(material.FileData);
    } catch (error) {
      console.log(`  #${index}: not a TAR (${error.message})`);
      continue;
    }
    const words = new Set();
    for (const entry of files) {
      if (!entry.name.endsWith(".xml")) continue;
      const text = entry.data.toString("utf8");
      for (const match of text.matchAll(/<data>([^<]+)<\/data>/g)) words.add(match[1]);
    }
    const pictures = [];
    for (const entry of files) {
      if (!entry.name.includes("thumbnail")) continue;
      const png = brushPngFromBytes(entry.data);
      if (!png) continue;
      let ink = 0;
      try {
        const image = decodePng(png);
        for (let at = 3; at < image.data.length; at += 4) if (image.data[at] > 8) ink += 1;
      } catch {
        ink = -1;
      }
      pictures.push(`${entry.name} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} ink=${ink}`);
    }
    console.log(`  #${index}: files=${files.map((entry) => entry.name).join(",")}`);
    console.log(`       words=${[...words].join(" | ")}`);
    console.log(`       ${pictures.join("; ")}`);
  }
  db.close();
}
