import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import {
  readClipDocumentFromBytes,
  readClipLayersFromBytes,
  clipToProject,
} from "../public/core/clip.js";
import { createClipBuffer } from "../src/clip-write.js";

const file = process.argv[2];

/** Name, kind and depth of every layer, in the order the project stores them. */
function shape(project) {
  const depth = (index) => {
    let steps = 0;
    let at = project.layers[index]?.parent ?? -1;
    while (at >= 0) {
      steps += 1;
      at = project.layers[at]?.parent ?? -1;
    }
    return steps;
  };
  return project.layers.map((layer, index) => ({
    name: layer.name,
    type: layer.type,
    depth: depth(index),
  }));
}

const data = new Buffer(fs.readFileSync(file));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data);
const project = clipToProject(document, layers);

const written = await createClipBuffer(project, { name: "tree round trip" });
if (process.argv[3]) {
  fs.writeFileSync(process.argv[3], written.buffer);
}
const back = clipToProject(
  await readClipDocumentFromBytes(written.buffer),
  await readClipLayersFromBytes(written.buffer),
);

const before = shape(project);
const after = shape(back).filter((layer) => layer.name !== "用紙");

let same = 0;
const firstDifference = [];
for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
  const a = before[index];
  const b = after[index];
  if (a && b && a.name === b.name && a.type === b.type && a.depth === b.depth) {
    same += 1;
  } else if (firstDifference.length < 6) {
    firstDifference.push({ index, before: a, after: b });
  }
}

console.log(`${file.split(/[\\/]/).pop()}: ${project.layers.length} layers in, `
  + `${after.length} back, ${same} match`);
if (firstDifference.length > 0) {
  for (const item of firstDifference) {
    console.log("  ", JSON.stringify(item));
  }
}
