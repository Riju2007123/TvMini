import fs from "node:fs";
import path from "node:path";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";

/**
 * Import every `.clip` given and report what came out.
 *
 *   node tools/clip-corpus.mjs <dir-or-file> [...]
 *
 * The point is to catch a document that used to import and no longer does,
 * and to show where the cells of an animation land. A document that fails is
 * listed with its error; the exit code is 1 when any document failed.
 */
const files = [];
for (const arg of process.argv.slice(2)) {
  if (fs.statSync(arg).isDirectory()) {
    for (const entry of fs.readdirSync(arg)) {
      if (/\.clip$/i.test(entry)) files.push(path.join(arg, entry));
    }
  } else {
    files.push(arg);
  }
}

let failed = 0;
for (const file of files) {
  try {
    const data = Buffer.from(fs.readFileSync(file));
    const document = await readClipDocumentFromBytes(data);
    const layers = await readClipLayersFromBytes(data, { includePaper: true });
    const project = clipToProject(document, layers, {});
    const cells = project.layers.filter((layer) => layer.preBehavior === "none" && layer.drawings.length);
    const spots = cells.flatMap((layer) => layer.drawings.map((drawing) => [drawing.at, drawing.hold]));
    const end = spots.reduce((max, [at, hold]) => Math.max(max, at + hold - 1), project.startFrame - 1);
    console.log(
      `OK   ${path.basename(file)}: ${project.width}x${project.height} ${project.fps}fps, ` +
      `${project.layers.length} layers, ${cells.length} cell layers, frames ${project.startFrame}..${end}`,
    );
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${path.basename(file)}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
