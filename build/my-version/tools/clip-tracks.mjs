/**
 * Show the tracks of a `.clip` file: what each one covers and which cells
 * it shows.
 *
 *   node tools/clip-tracks.mjs [file]
 */
import fs from "node:fs/promises";

import { readClipDocumentFromBytes } from "../src/clip.js";
import { Buffer } from "../public/core/bytes.js";

const FILE = process.argv[2] ?? "C:\\Users\\MK\\Documents\\Animation3.clip";
const data = Buffer.from(await fs.readFile(FILE));
const document = await readClipDocumentFromBytes(data);

console.log(`the file: ${FILE}`);
console.log(
  `  the timeline of the document: ${document.timeline.startFrame}..${document.timeline.endFrame}` +
    ` at ${document.timeline.frameRate} fps`,
);
console.log(`  ${document.tracks.length} tracks, ${document.layers.length} layers`);

const byUuid = new Map(document.layers.map((layer) => [String(layer.uuid ?? "").replace(/-/g, "").toLowerCase(), layer.name]));

for (const track of document.tracks ?? []) {
  const action = track?.action2 ?? track?.action;
  const range = action?.clipRange ?? null;
  const keys = action?.celKeys ?? [];
  const key = String(track?.layerUuid ?? "").replace(/-/g, "").toLowerCase();
  console.log(
    `  track kind ${track?.kind} of "${byUuid.get(key) ?? track?.layerUuid ?? "?"}":` +
      ` ${range ? `${range.start}..${range.end}` : "no range"}` +
      (keys.length
        ? `, cells ${keys.map((one) => `${one.tag}@${one.time}`).join(" ")}`
        : action?.celSequence?.length
          ? `, ${action.celSequence.length} cells in a run`
          : ", no cells"),
  );
}
