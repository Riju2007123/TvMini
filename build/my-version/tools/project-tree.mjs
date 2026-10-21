import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";

const data = Buffer.from(fs.readFileSync(process.argv[2]));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});
console.log(`start ${project.startFrame} frame ${project.currentFrame} fps ${project.fps}`);
project.layers.forEach((layer, index) => {
  const drawings = layer.drawings
    .map((drawing) => `${drawing.at}${drawing.name ? `(${drawing.name})` : ""}`)
    .join(",");
  console.log(
    `${String(index).padStart(3)} ${JSON.stringify(layer.name).padEnd(22)} parent=${String(layer.parent).padStart(3)} ` +
    `type=${layer.type.padEnd(5)} pre=${layer.preBehavior.padEnd(4)} drawings=[${drawings}]`,
  );
});
