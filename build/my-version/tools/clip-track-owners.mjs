import { readClipDocumentFromBytes } from "../public/core/clip.js";
import { Buffer } from "../public/core/bytes.js";
import fs from "node:fs";

const bytes = fs.readFileSync(process.argv[2]);
const document = await readClipDocumentFromBytes(new Buffer(bytes));
const key = (value) => String(value ?? "").replace(/-/g, "").toLowerCase();
const nodes = new Map((document.layerTree ?? []).map((node) => [key(node.uuid), node]));

for (const track of document.tracks ?? []) {
  const node = nodes.get(key(track.layerUuid));
  const curves = track.action2?.properties ?? [];
  console.log(
    `track ${track.mainId} kind ${track.kind} -> "${node?.name ?? "?"}"` +
      `${node?.animationFolder ? " (animation folder)" : ""}${node?.folder ? " (folder)" : ""}` +
      `  properties: ${curves.join(", ")}`,
  );
}
