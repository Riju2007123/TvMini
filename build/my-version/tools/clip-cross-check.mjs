import fs from "node:fs";
import { createProject } from "../src/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { renderProject, encodePng } from "../public/core/png.js";

/**
 * Write the files the cross-check needs.
 *
 *   node tools/clip-cross-check.mjs <outdir>
 *
 * It writes the `.clip` the writer produces and the PNG of the same project
 * as this application renders it. A second implementation composites the
 * `.clip` and the two images are compared pixel by pixel.
 */
const outdir = process.argv[2] ?? ".";
fs.mkdirSync(outdir, { recursive: true });

const project = createProject(320, 240, "#ffffff");
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

const written = await createClipBuffer(project, { name: "cross check" });
const clipPath = `${outdir}/cross-check.clip`;
fs.writeFileSync(clipPath, written.buffer);

const rendered = renderProject(project, 1);
const png = encodePng(rendered.width, rendered.height, rendered.data);
fs.writeFileSync(`${outdir}/tvmini-render.png`, png);
console.log(`wrote ${clipPath} (${written.buffer.length} bytes)`);
console.log(`wrote ${outdir}/tvmini-render.png (${png.length} bytes)`);
console.log(`render size ${rendered.width}x${rendered.height}`);
