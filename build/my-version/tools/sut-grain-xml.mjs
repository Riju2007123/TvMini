/**
 * Look at one material inside a Clip Studio Paint brush.
 *
 *   node tools/sut-grain-xml.mjs "brush.sut" [index]
 */
import { DatabaseSync } from "node:sqlite";
import { readTar } from "../public/core/tar.js";

const file = process.argv[2];
const only = process.argv[3] === undefined ? null : Number(process.argv[3]);

const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT FileData FROM MaterialFile").all();

for (const [index, material] of materials.entries()) {
  if (only !== null && index !== only) continue;
  const files = readTar(material.FileData);
  console.log(`\n=== material #${index} ===`);
  for (const entry of files) {
    console.log(`${entry.name}  ${entry.data.length} bytes`);
    if (!entry.name.endsWith(".xml")) continue;
    console.log(entry.data.toString("utf8"));
  }
}

console.log("\n=== TextureImage blobs ===");
const rows = db.prepare("SELECT VariantID, TextureImage FROM Variant").all();
for (const row of rows) {
  if (!row.TextureImage) continue;
  const bytes = Buffer.from(row.TextureImage);
  console.log(`variant ${row.VariantID}: ${bytes.length} bytes`);
  console.log(bytes.toString("hex").match(/.{1,64}/g).join("\n"));
}
db.close();
