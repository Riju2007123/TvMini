/**
 * Write down the shape of a Clip Studio Paint brush.
 *
 * A `.sut` file is a SQLite database with a `Manager`, a `Node` and a
 * `Variant` table. This prints the statements that make those tables and the
 * values a plain brush holds, so a writer can be built from the format
 * instead of guessing at it.
 *
 *   node tools/sut-schema.mjs "C:\path\to\brush.sut" > sut-schema.txt
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });

const schema = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('Manager','Node','Variant')")
  .all()
  .map((row) => row.sql)
  .join(";\n\n");

console.log("-- the tables --");
console.log(schema);

console.log("\n-- the values of a plain brush --");
const variant = db
  .prepare("SELECT * FROM Variant WHERE VariantID = (SELECT NodeVariantID FROM Node)")
  .get();
const plain = {};
const blobs = [];
for (const [key, value] of Object.entries(variant)) {
  if (value === null) continue;
  if (value instanceof Uint8Array) {
    blobs.push(`${key}: ${value.length} bytes`);
    continue;
  }
  plain[key] = value;
}
console.log(JSON.stringify(plain, null, 2));
console.log("\n-- the blobs --");
console.log(blobs.join("\n"));

console.log("\n-- the manager --");
console.log(JSON.stringify(db.prepare("SELECT * FROM Manager").get(), null, 2));
console.log("\n-- the node --");
const node = db.prepare("SELECT * FROM Node").get();
const plainNode = {};
for (const [key, value] of Object.entries(node)) {
  plainNode[key] = value instanceof Uint8Array ? `<${value.length} bytes>` : value;
}
console.log(JSON.stringify(plainNode, null, 2));

db.close();
