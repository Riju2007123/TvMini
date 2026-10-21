// Cut a rectangle out of a PNG, so a part of a picture can be looked at.
import fs from "node:fs";
import { decodePng, encodePng } from "../public/core/png.js";

const [file, x, y, w, h, out] = process.argv.slice(2);
const png = decodePng(fs.readFileSync(file));
const width = Number(w);
const height = Number(h);
const cut = Buffer.alloc(width * height * 3);
for (let row = 0; row < height; row += 1) {
  for (let column = 0; column < width; column += 1) {
    const from = ((Number(y) + row) * png.width + (Number(x) + column)) * 4;
    const to = (row * width + column) * 3;
    cut[to] = png.data[from];
    cut[to + 1] = png.data[from + 1];
    cut[to + 2] = png.data[from + 2];
  }
}
fs.writeFileSync(out, encodePng(width, height, cut));
console.log(`cut ${w}x${h} at ${x},${y} -> ${out}`);
