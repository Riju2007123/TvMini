/**
 * List the files inside the material of a brush.
 *
 * The material of a brush is a TAR archive. This prints the name and the
 * size of every file in it.
 *
 *   node tools/sut-tar.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, FileData FROM MaterialFile").all();
db.close();

for (const material of materials) {
  const data = Buffer.from(material.FileData);
  console.log(`\n== MaterialFile ${material._PW_ID}: ${data.length} bytes ==`);
  let at = 0;
  while (at + 512 <= data.length) {
    const name = data.toString("utf8", at, at + 100).replace(/\0.*$/, "");
    const size = Number.parseInt(data.toString("ascii", at + 124, at + 136).replace(/\0.*$/, "").trim(), 8) || 0;
    const type = data.toString("ascii", at + 156, at + 157);
    if (!name && !size) {
      at += 512;
      continue;
    }
    console.log(
      `  at ${at}: ${JSON.stringify(name)} — ${size} bytes, type ${JSON.stringify(type)}`,
    );
    at += 512 + Math.ceil(size / 512) * 512;
  }
}
