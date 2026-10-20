import fs from "node:fs";
import { createProject } from "../src/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { renderProject, encodePng } from "../public/core/png.js";

/**
 * Write the files the Clip Studio Paint check needs.
 *
 *   node tools/clip-csp-export.mjs <outdir>
 *
 * The paper is a colour that does not occur anywhere else in the interface,
 * so the canvas can be found in a screenshot of the application by looking
 * for that one colour. The result is a document that the real application
 * can be asked to open, and the picture it should show.
 */
const outdir = process.argv[2] ?? ".";
fs.mkdirSync(outdir, { recursive: true });

// A colour that is not in the interface and not in the drawing.
export const PAPER = "#ff00ff";

const project = createProject(320, 240, PAPER);
project.layers[0].drawings = [
  { at: 1, hold: 3, strokes: [{ color: "#ff0000", width: 10, points: [[40, 40], [280, 200]] }] },
];
project.layers.push({
  ...createProject(320, 240).layers[0],
  name: "second layer",
  opacity: 0.5,
  drawings: [
    { at: 1, hold: 3, strokes: [{ color: "#0000ff", width: 20, points: [[100, 100], [200, 150]] }] },
  ],
});

const written = await createClipBuffer(project, { name: "csp check" });
fs.writeFileSync(`${outdir}/csp-check.clip`, written.buffer);

const rendered = renderProject(project, 1);
fs.writeFileSync(`${outdir}/csp-expected.png`, encodePng(rendered.width, rendered.height, rendered.data));

console.log(`${outdir}/csp-check.clip (${written.buffer.length} bytes, ${written.width}x${written.height})`);
console.log(`${outdir}/csp-expected.png`);
