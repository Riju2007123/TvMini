/**
 * Map the shape of the material file of a brush.
 *
 * The material file starts with "catalog.zip", then a header, then an
 * archive. This prints where every interesting marker sits, so the layout
 * can be worked out without printing megabytes of picture.
 *
 *   node tools/sut-shape.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, OriginalPath, FileData FROM MaterialFile").all();
db.close();

const markers = [
  ["the zip header", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ["the end of the zip", Buffer.from([0x50, 0x4b, 0x05, 0x06])],
  ["a tar header", Buffer.from("ustar", "latin1")],
  ["the picture", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ["the end of the picture", Buffer.from("IEND", "latin1")],
  ["the layer description", Buffer.from("layerData.xml", "latin1")],
  ["the catalog name", Buffer.from("catalog.zip", "latin1")],
];

for (const material of materials) {
  const data = Buffer.from(material.FileData);
  console.log(`\n== MaterialFile ${material._PW_ID}: ${data.length} bytes ==`);
  console.log(`  ${material.OriginalPath}`);
  for (const [name, marker] of markers) {
    const places = [];
    let at = data.indexOf(marker);
    while (at !== -1 && places.length < 6) {
      places.push(at);
      at = data.indexOf(marker, at + 1);
    }
    console.log(`  ${name}: ${places.join(", ") || "not here"}`);
  }
  // The bytes between the catalog name and the archive.
  const zip = data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (zip > 0) {
    console.log(`  the header before the archive (${zip} bytes):`);
    console.log(`    ${data.subarray(0, Math.min(zip, 128)).toString("hex")}`);
  }
}
