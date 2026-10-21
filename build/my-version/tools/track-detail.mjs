import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { readClipDocumentFromBytes } from "../public/core/clip.js";

const data = Buffer.from(fs.readFileSync(process.argv[2]));
const document = await readClipDocumentFromBytes(data);
for (const track of document.tracks ?? []) {
  console.log(
    `track ${track.mainId} kind ${track.kind} layer ${String(track.layerUuid).slice(0, 8)} ` +
      `mixer1 keys=${JSON.stringify(track.action?.celKeys ?? null)} seq=${JSON.stringify(track.action?.celSequence ?? null)} | ` +
      `mixer2 keys=${JSON.stringify(track.action2?.celKeys ?? null)} seq=${JSON.stringify(track.action2?.celSequence ?? null)}`,
  );
}
