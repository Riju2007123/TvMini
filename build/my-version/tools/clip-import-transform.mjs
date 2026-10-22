/**
 * The transform of the cells an imported document carries.
 *
 *   node tools/clip-import-transform.mjs file.clip
 */
import { readClipProject } from "../src/clip.js";

const file = process.argv[2];
const project = (await readClipProject(file)).project;
let layers = 0;
let cells = 0;
for (const layer of project.layers) {
  const moves = [];
  if (layer.transform) {
    layers += 1;
    const t = layer.transform;
    moves.push(`layer ${Math.round(t.x)},${Math.round(t.y)} ×${t.scale.toFixed(2)} ${Math.round(t.rotation)}°`);
  }
  for (const drawing of layer.drawings ?? []) {
    if (!drawing.transform) continue;
    cells += 1;
    const t = drawing.transform;
    moves.push(
      `cell "${drawing.name}" at ${drawing.at}: ${Math.round(t.x)},${Math.round(t.y)} ×${t.scale.toFixed(2)} ${Math.round(t.rotation)}°`,
    );
  }
  if (moves.length) console.log(`"${layer.name}": ${moves.join(" | ")}`);
}
console.log(`${layers} layer(s) and ${cells} cell(s) carry a transform`);
