import fs from "node:fs";
import { createProject } from "../src/model.js";
import { createClipBuffer } from "../src/clip-write.js";
import { encodePng } from "../public/core/png.js";

/**
 * Export a set of `.clip` files that cover the writer's paths.
 *
 *   node tools/clip-export-all.mjs <outdir>
 *
 * Every file that comes out is checked by the reference implementation: its
 * structure by `clip-validate`, and the pixels of the cross-check case by
 * `clip_cross_check.py`.
 */
const outdir = process.argv[2] ?? ".";
fs.mkdirSync(outdir, { recursive: true });

/** A solid colour picture, as a PNG in base64. */
function solid(width, height, [r, g, b]) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return encodePng(width, height, data).toString("base64");
}

const cases = [];

{
  // A single layer with one stroke.
  const project = createProject(320, 240, "#ffffff");
  project.layers[0].drawings = [
    { at: 1, hold: 3, strokes: [{ color: "#ff0000", width: 10, points: [[40, 40], [280, 200]] }] },
  ];
  cases.push(["single-layer", project]);
}

{
  // Several layers, with different opacities, one of them hidden.
  const project = createProject(320, 240, "#ffffff");
  project.layers[0].drawings = [
    { at: 1, hold: 3, strokes: [{ color: "#ff0000", width: 10, points: [[40, 40], [280, 200]] }] },
  ];
  project.layers.push({
    ...createProject(320, 240).layers[0],
    name: "half",
    opacity: 0.5,
    drawings: [
      { at: 1, hold: 3, strokes: [{ color: "#0000ff", width: 20, points: [[100, 100], [200, 150]] }] },
    ],
  });
  project.layers.push({
    ...createProject(320, 240).layers[0],
    name: "hidden",
    visible: false,
    drawings: [
      { at: 1, hold: 3, strokes: [{ color: "#00ff00", width: 30, points: [[10, 10], [300, 220]] }] },
    ],
  });
  cases.push(["three-layers", project]);
}

{
  // A project with no layers at all.
  const project = createProject(320, 240, "#ffffff");
  project.layers = [];
  cases.push(["no-layers", project]);
}

{
  // An imported picture behind a stroke.
  const project = createProject(64, 48, "#ffffff");
  project.image = {
    data: solid(64, 48, [200, 0, 0]),
    width: 64,
    height: 48,
  };
  project.layers[0].drawings = [
    { at: 1, hold: 1, strokes: [{ color: "#0000ff", width: 6, points: [[32, 24]] }] },
  ];
  cases.push(["imported-image", project]);
}

{
  // A canvas that is bigger than one tile, so the tiles are written out.
  const project = createProject(800, 600, "#ffffff");
  project.layers[0].drawings = [
    { at: 1, hold: 3, strokes: [{ color: "#ff0000", width: 30, points: [[50, 50], [750, 550]] }] },
  ];
  cases.push(["large-canvas", project]);
}

{
  // A canvas that is smaller than one tile.
  const project = createProject(32, 24, "#ffffff");
  project.layers[0].drawings = [
    { at: 1, hold: 1, strokes: [{ color: "#ff0000", width: 4, points: [[4, 4], [28, 20]] }] },
  ];
  cases.push(["small-canvas", project]);
}

for (const [name, project] of cases) {
  const written = await createClipBuffer(project, { name });
  const path = `${outdir}/${name}.clip`;
  fs.writeFileSync(path, written.buffer);
  console.log(`${path} (${written.buffer.length} bytes, ${written.width}x${written.height})`);
}
