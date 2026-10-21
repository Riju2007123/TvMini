/**
 * Render the frames of a .clip the way the reader sees them.
 *
 *   node tools/reader-frames.mjs file.clip outDir [frame ...]
 *
 * Every frame is drawn with the pictures the reader read, so the result can be
 * compared with what another program shows for the same file.
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";
import { encodePng, renderProject } from "../public/core/png.js";

const [file, outDir, ...frames] = process.argv.slice(2);
if (!file || !outDir) {
  console.error("usage: node tools/reader-frames.mjs file.clip outDir [frame ...]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const data = Buffer.from(fs.readFileSync(file));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});

const wanted = frames.length
  ? frames.map((value) => Number(value))
  : Array.from({ length: 8 }, (_, index) => project.startFrame + index);

for (const frame of wanted) {
  const picture = renderProject(project, frame);
  const file2 = path.join(outDir, `frame-${String(frame).padStart(4, "0")}.png`);
  fs.writeFileSync(file2, encodePng(picture.width, picture.height, picture.data));
  console.log(`frame ${frame} -> ${file2}`);
}

// What the reader thinks is on screen at each frame.
const onScreen = [];
for (let frame = project.startFrame; frame <= project.startFrame + 20; frame += 1) {
  const names = project.layers
    .filter((layer) => layer.drawings.some((drawing) => drawing.at <= frame && frame < drawing.at + drawing.hold))
    .map((layer) => layer.name);
  onScreen.push(`${frame}: ${names.join(", ")}`);
}
console.log(onScreen.join("\n"));
