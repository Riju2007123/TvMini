/**
 * Look at every picture inside the material of a brush.
 *
 * The tip of a brush is kept by Clip Studio Paint in a file of its own, and
 * that file holds more than one picture. This prints every picture in it,
 * with its size and how much of it is opaque.
 *
 *   node tools/sut-pictures.mjs "C:\path\to\brush.sut"
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readTar } from "../public/core/tar.js";
import { decodePng } from "../public/core/png.js";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, FileData FROM MaterialFile").all();
db.close();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every picture in a file, with where it starts. */
function pictures(bytes) {
  const found = [];
  let at = bytes.indexOf(PNG);
  while (at !== -1) {
    found.push({ at, data: bytes.subarray(at) });
    at = bytes.indexOf(PNG, at + 1);
  }
  return found;
}

for (const material of materials) {
  console.log(`\n== material ${material._PW_ID} ==`);
  for (const entry of readTar(Buffer.from(material.FileData))) {
    console.log(`  ${entry.name}: ${entry.data.length} bytes`);
    for (const picture of pictures(entry.data)) {
      let info = "not a picture";
      try {
        const image = decodePng(picture.data);
        let clear = 0;
        let opaque = 0;
        for (let index = 3; index < image.data.length; index += 4) {
          if (image.data[index] === 0) clear += 1;
          else if (image.data[index] === 255) opaque += 1;
        }
        info = `${image.width} by ${image.height}, ${opaque} opaque and ${clear} clear`;
      } catch (error) {
        info = `could not be read: ${error.message}`;
      }
      console.log(`    a picture at ${picture.at}: ${info}`);
    }
  }
}
