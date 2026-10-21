/**
 * List the ZIP archive inside the material file of a brush.
 *
 * The material file is "catalog.zip", a header of zeros and then a ZIP
 * archive. This prints where the archive starts and what is in it.
 *
 *   node tools/sut-zip.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, FileData FROM MaterialFile").all();
db.close();

for (const material of materials) {
  const data = Buffer.from(material.FileData);
  const start = data.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  console.log(`\n== MaterialFile ${material._PW_ID}: ${data.length} bytes, the zip starts at ${start} ==`);
  console.log(`  the header before the zip: ${data.subarray(0, start).toString("latin1").replace(/[^\x20-\x7e]/g, ".")}`);

  let index = start;
  while (index + 30 <= data.length && data.readUInt32LE(index) === 0x04034b50) {
    const method = data.readUInt16LE(index + 8);
    const compressed = data.readUInt32LE(index + 18);
    const plain = data.readUInt32LE(index + 22);
    const nameLength = data.readUInt16LE(index + 26);
    const extraLength = data.readUInt16LE(index + 28);
    const name = data.toString("utf8", index + 30, index + 30 + nameLength);
    console.log(
      `  ${name} — method ${method}, ${plain} bytes plain, ${compressed} bytes stored`,
    );
    index = index + 30 + nameLength + extraLength + compressed;
  }
}
