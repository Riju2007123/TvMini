/**
 * Look inside the material file of a Clip Studio Paint brush.
 *
 * The material file starts with the word "catalog." and holds the picture of
 * the tip of the brush inside ZIP archives. This prints the header and finds
 * where the picture sits.
 *
 *   node tools/sut-catalog.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.log("usage: node tools/sut-catalog.mjs <brush.sut>");
  process.exit(1);
}

const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, FileData FROM MaterialFile").all();
db.close();

for (const material of materials) {
  const data = Buffer.from(material.FileData);
  console.log(`\n== MaterialFile ${material._PW_ID}: ${data.length} bytes ==`);
  console.log(data.subarray(0, 96).toString("hex").replace(/(.{32})/g, "$1\n  "));
  console.log(`  as text: ${data.subarray(0, 96).toString("latin1").replace(/[^\x20-\x7e]/g, ".")}`);

  // Where does the picture sit?
  let index = data.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  console.log(`  the first PNG starts at ${index}`);
  if (index > 0) {
    console.log(`  the bytes before it: ${data.subarray(Math.max(0, index - 64), index).toString("hex")}`);
  }
}
