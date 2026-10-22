/**
 * Look at the file that holds the picture of a Clip Studio Paint brush.
 *
 * The material of a brush is a TAR archive. The picture of the tip sits in
 * the file `data/material_0.layer`, but that file is not a plain picture: it
 * has a header of its own, and the picture is inside it.
 *
 *   node tools/sut-layer-probe.mjs "C:\path\to\brush.sut"
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readTar } from "../public/core/tar.js";

const file = process.argv[2];
const db = new DatabaseSync(file, { readOnly: true });
const materials = db.prepare("SELECT _PW_ID, FileData FROM MaterialFile").all();
db.close();

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const material of materials) {
  const entries = readTar(Buffer.from(material.FileData));
  for (const entry of entries) {
    if (!entry.name.startsWith("data/")) continue;
    console.log(`\n== ${entry.name} (${entry.data.length} bytes) ==`);
    console.log(`  the first 32 bytes: ${entry.data.subarray(0, 32).toString("hex")}`);
    console.log(`  as text: ${entry.data.subarray(0, 32).toString("latin1").replace(/[^\x20-\x7e]/g, ".")}`);

    let at = entry.data.indexOf(PNG);
    console.log(`  the first picture starts at ${at}`);
    if (at > 0) {
      console.log(`  the bytes before it: ${entry.data.subarray(Math.max(0, at - 48), at).toString("hex")}`);
      const width = entry.data.readUInt32BE(at + 16);
      const height = entry.data.readUInt32BE(at + 20);
      console.log(`  the picture is ${width} by ${height}`);
      const out = `${process.env.TEMP ?? "."}\\tvmini-test\\tip-${material._PW_ID}.png`;
      fs.mkdirSync(out.replace(/[^\\/]+$/, ""), { recursive: true });
      fs.writeFileSync(out, entry.data.subarray(at));
      console.log(`  written to ${out}`);
    }
  }
}
