import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";

const file = process.argv[2];
const data = Buffer.from(fs.readFileSync(file));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});

console.log("camera:", JSON.stringify(project.camera, null, 1));
console.log("layers:");
for (const [index, layer] of project.layers.entries()) {
  console.log(
    `  ${index} ${JSON.stringify(layer.name)} parent=${layer.parent} type=${layer.type} ` +
      `visible=${layer.visible} opacity=${layer.opacity} pre=${layer.preBehavior} ` +
      `drawings=${layer.drawings.map((d) => `${d.at}${d.name ? `(${d.name})` : ""}+${d.hold}`).join(",")}`,
  );
}
