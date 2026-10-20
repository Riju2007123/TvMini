import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { readClipDocumentFromBytes, readClipLayersFromBytes, clipToProject } from "../public/core/clip.js";

const path = process.argv[2];
const data = Buffer.from(fs.readFileSync(path));

const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});

console.log(`canvas ${project.width}x${project.height} fps=${project.fps} start=${project.startFrame} current=${project.currentFrame}`);
console.log(`layers: ${project.layers.length}`);
for (const [index, layer] of project.layers.entries()) {
  const cells = layer.drawings
    .map((d) => `${d.name ?? "-"}@${d.at}+${d.hold}${d.image ? " (picture)" : ""}`)
    .join(", ");
  console.log(
    `  [${index}] ${layer.type.padEnd(5)} parent=${String(layer.parent).padStart(2)} "${layer.name}"  ${cells}`,
  );
}
