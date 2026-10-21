/**
 * Look at the picture inside a Clip Studio Paint brush.
 *
 * The picture of the tip of a brush can sit in two places: straight in the
 * `TextureImage` column of the settings, or inside the ZIP file in
 * `MaterialFile`. This prints what is in each of them.
 *
 *   node tools/sut-texture.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const file = process.argv[2];
if (!file) {
  console.log("usage: node tools/sut-texture.mjs <brush.sut>");
  process.exit(1);
}

const db = new DatabaseSync(file, { readOnly: true });

/** The names of the files inside a ZIP archive. */
function zipNames(bytes) {
  const names = [];
  let index = 0;
  while (index + 30 <= bytes.length) {
    if (bytes.readUInt32LE(index) !== 0x04034b50) break;
    const method = bytes.readUInt16LE(index + 8);
    const size = bytes.readUInt32LE(index + 18);
    const nameLength = bytes.readUInt16LE(index + 26);
    const extraLength = bytes.readUInt16LE(index + 28);
    const name = bytes.toString("utf8", index + 30, index + 30 + nameLength);
    const start = index + 30 + nameLength + extraLength;
    names.push({ name, method, size });
    index = start + size;
  }
  return names;
}

const variants = db.prepare("SELECT VariantID, TextureImage FROM Variant").all();
for (const variant of variants) {
  const image = variant.TextureImage;
  if (!image) continue;
  console.log(`\n-- TextureImage of variant ${variant.VariantID}: ${image.length} bytes --`);
  console.log(`  the first bytes: ${Buffer.from(image.subarray(0, 24)).toString("hex")}`);
  if (Buffer.from(image.subarray(0, 8)).toString("hex") === "89504e470d0a1a0a") {
    console.log("  it is a PNG");
    writeFileSync("sut-texture.png", Buffer.from(image));
    console.log("  written to sut-texture.png");
  }
}

const materials = db.prepare("SELECT _PW_ID, OriginalPath, FileData FROM MaterialFile").all();
for (const material of materials) {
  const data = Buffer.from(material.FileData);
  console.log(`\n-- MaterialFile ${material._PW_ID}: ${data.length} bytes --`);
  console.log(`  ${material.OriginalPath}`);
  console.log(`  the first bytes: ${data.subarray(0, 8).toString("hex")}`);
  for (const entry of zipNames(data)) {
    console.log(`  in the zip: ${entry.name} (${entry.size} bytes, method ${entry.method})`);
  }
}

db.close();
