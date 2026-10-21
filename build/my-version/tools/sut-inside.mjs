/**
 * Open the files inside the material of a brush.
 *
 * The material is a TAR archive with a few entries. Every entry except the
 * XML is a ZIP archive. This prints the names of the files inside those
 * archives and shows the XML.
 *
 *   node tools/sut-inside.mjs "C:\path\to\brush.sut"
 */
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT FileData FROM MaterialFile").all();
db.close();

/** The files inside a ZIP archive. */
function zipEntries(bytes) {
  const entries = [];
  let index = 0;
  while (index + 30 <= bytes.length && bytes.readUInt32LE(index) === 0x04034b50) {
    const method = bytes.readUInt16LE(index + 8);
    const compressed = bytes.readUInt32LE(index + 18);
    const plain = bytes.readUInt32LE(index + 22);
    const nameLength = bytes.readUInt16LE(index + 26);
    const extraLength = bytes.readUInt16LE(index + 28);
    const name = bytes.toString("utf8", index + 30, index + 30 + nameLength);
    const start = index + 30 + nameLength + extraLength;
    let data = bytes.subarray(start, start + compressed);
    if (method === 8) data = inflateRawSync(data);
    entries.push({ name, plain, data });
    index = start + compressed;
  }
  return entries;
}

/** The files inside a TAR archive. */
function tarEntries(bytes) {
  const entries = [];
  let at = 0;
  while (at + 512 <= bytes.length) {
    const name = bytes.toString("utf8", at, at + 100).replace(/\0.*$/, "");
    const size = Number.parseInt(bytes.toString("ascii", at + 124, at + 136).replace(/\0.*$/, "").trim(), 8) || 0;
    if (!name && !size) {
      at += 512;
      continue;
    }
    entries.push({ name, size, data: bytes.subarray(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const material = Buffer.from(materials[0].FileData);
for (const entry of tarEntries(material)) {
  console.log(`\n== ${entry.name} (${entry.size} bytes) ==`);
  if (entry.name.endsWith(".png")) {
    console.log("  a picture");
    continue;
  }
  if (entry.name.endsWith(".xml")) {
    console.log(entry.data.toString("utf8").slice(0, 2000));
    continue;
  }
  for (const inner of zipEntries(entry.data)) {
    console.log(`  in the zip: ${JSON.stringify(inner.name)} — ${inner.plain} bytes`);
    if (inner.name.endsWith(".xml")) {
      console.log(inner.data.toString("utf8").slice(0, 1500));
    }
  }
}
