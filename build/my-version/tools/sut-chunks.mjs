/**
 * Look at the file that holds the picture of a Clip Studio Paint brush.
 *
 * The picture of the tip sits in the file `data/material_0.layer` of the
 * material. That file has a header of its own: a signature and then a list
 * of parts, each with a name. This prints those parts.
 *
 *   node tools/sut-chunks.mjs "C:\path\to\brush.sut"
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readTar } from "../public/core/tar.js";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, OriginalPath, FileData FROM MaterialFile").all();
db.close();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const material of materials) {
  const entries = readTar(Buffer.from(material.FileData));
  const xml = entries.find((entry) => entry.name.endsWith(".xml"));
  const kind = xml ? (xml.data.toString("utf8").includes("BrushPattern") ? "brush shape" : "other") : "?";
  console.log(`\n== material ${material._PW_ID} (${kind}) ==`);

  for (const entry of entries) {
    if (!entry.name.startsWith("data/")) continue;
    const data = entry.data;
    console.log(`  ${entry.name}: ${data.length} bytes`);
    console.log(`    the signature: ${data.subarray(0, 12).toString("latin1").replace(/[^\x20-\x7e]/g, ".")}`);

    // The parts: a name of four letters and then the size.
    let at = 12;
    while (at + 8 <= data.length) {
      const name = data.toString("latin1", at, at + 4);
      if (!/^[A-Z0-9]{4}$/.test(name)) break;
      const size = data.readUInt32BE(at + 4);
      const body = data.subarray(at + 8, at + 8 + size);
      const at_ = body.indexOf(PNG);
      console.log(
        `    ${name}: ${size} bytes` +
          (at_ >= 0
            ? `, a picture at ${at_} (${body.readUInt32BE(at_ + 16)} by ${body.readUInt32BE(at_ + 20)})`
            : ""),
      );
      at += 8 + size;
    }
  }
}
