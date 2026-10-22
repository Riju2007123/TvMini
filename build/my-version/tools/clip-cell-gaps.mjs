/**
 * The cells of a project follow each other, and the written file says so.
 *
 *   node tools/clip-cell-gaps.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject } from "../public/core/model.js";
import { insertDrawing } from "../public/timeline.js";
import { createClipBuffer } from "../src/clip-write.js";
import { readClipProject, readClipDocument } from "../src/clip.js";

const project = createProject(480, 270);
project.fps = 24;
const layer = project.layers[0];

for (const frame of [1, 3, 8]) {
  const cell = insertDrawing(layer, frame);
  cell.name = String(frame);
  cell.strokes = [
    { color: "#e04030", width: 6, points: [[40, 40 + frame * 10], [200, 40 + frame * 10]] },
  ];
}

console.log("the project:");
for (const drawing of layer.drawings) {
  console.log(`  cell "${drawing.name}" at ${drawing.at}, held ${drawing.hold} frame(s)`);
}

const written = await createClipBuffer(project, { name: "gaps", animation: true });
const file = path.join(os.tmpdir(), "tvmini-cell-gaps.clip");
await fs.writeFile(file, Buffer.from(written.buffer));

console.log("\nthe written file:");
const document = await readClipDocument(file);
for (const track of document.tracks ?? []) {
  const action = track.action2;
  if (!action?.celKeys?.length) continue;
  console.log(
    `  track ${track.mainId}: cells ${action.celKeys.map((key) => `${key.tag}@${key.time}`).join(" ")}` +
      ` range ${JSON.stringify(action.clipRange)}`,
  );
}
const layers = (await readClipProject(file)).project.layers;
for (const layer of layers) {
  for (const drawing of layer.drawings ?? []) {
    console.log(`  read back: layer "${layer.name}" cell "${drawing.name}" at ${drawing.at}, held ${drawing.hold} frame(s)`);
  }
}
await fs.rm(file, { force: true });
