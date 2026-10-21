// Find the cells of a Clip Studio project and draw them as one picture, so a
// document can be looked at whole.
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";
import { encodePng, renderProject } from "../public/core/png.js";

const [file, out, frameText] = process.argv.slice(2);
const data = Buffer.from(fs.readFileSync(file));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});
project.camera = null;
const picture = renderProject(project, Number(frameText ?? project.currentFrame));
fs.writeFileSync(out, encodePng(picture.width, picture.height, picture.data));
console.log(`${out} ${picture.width}x${picture.height}`);
