// Find the red camera rectangle in a screenshot of Umoupen: the edges are the
// rows and columns that carry a long run of red, so the program counts them
// instead of taking the outermost red pixel, which belongs to the interface.
import fs from "node:fs";
import { decodePng } from "../public/core/png.js";

const file = process.argv[2];
const png = decodePng(fs.readFileSync(file));
const { width, height, data } = png;

const isRed = (x, y) => {
  const at = (y * width + x) * 4;
  return data[at] > 190 && data[at + 1] < 90 && data[at + 2] < 90;
};

const rows = [];
for (let y = 0; y < height; y += 1) {
  let run = 0;
  for (let x = 0; x < width; x += 1) {
    if (isRed(x, y)) run += 1;
  }
  if (run > 200) rows.push([y, run]);
}
const columns = [];
for (let x = 0; x < width; x += 1) {
  let run = 0;
  for (let y = 0; y < height; y += 1) {
    if (isRed(x, y)) run += 1;
  }
  if (run > 200) columns.push([x, run]);
}
console.log("rows with a long red run:", JSON.stringify(rows));
console.log("columns with a long red run:", JSON.stringify(columns));
