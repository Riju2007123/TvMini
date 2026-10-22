/**
 * Compare what the reader of a brush finds with the picture that is really
 * the tip of the brush.
 *
 *   node tools/sut-tip-probe.mjs "C:\path\to\brush.sut"
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readSutBrush } from "../public/core/sut.js";
import { readTar } from "../public/core/tar.js";

const files = process.argv.slice(2);
for (const file of files) {
  console.log(`\n${file}`);
  const brush = await readSutBrush(fs.readFileSync(file));
  console.log(
    brush
      ? `  the reader finds a picture of ${brush.texture.width} by ${brush.texture.height}` +
        ` (${Buffer.from(brush.texture.data, "base64").length} bytes), size ${brush.size}`
      : "  the reader finds no picture",
  );

  const db = new DatabaseSync(file, { readOnly: true });
  const materials = db.prepare("SELECT _PW_ID, FileData FROM MaterialFile").all();
  db.close();
  for (const material of materials) {
    const files = readTar(Buffer.from(material.FileData));
    for (const entry of files) {
      if (!entry.name.endsWith(".png") && !entry.name.startsWith("data/")) continue;
      const width = entry.data.readUInt32BE(16);
      const height = entry.data.readUInt32BE(20);
      console.log(`  in the material: ${entry.name} — ${width} by ${height}, ${entry.data.length} bytes`);
    }
  }
}
