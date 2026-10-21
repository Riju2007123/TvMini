// Measure the page and the camera rectangle in a screenshot of Umoupen, so
// the camera of the file can be put against the picture: the page is the
// white area, the pasteboard around it is grey.
import fs from "node:fs";
import { decodePng } from "../public/core/png.js";

const file = process.argv[2];
const png = decodePng(fs.readFileSync(file));
const { width, height, data } = png;

const at = (x, y) => (y * width + x) * 4;
const isWhite = (x, y) => {
  const p = at(x, y);
  return data[p] > 235 && data[p + 1] > 235 && data[p + 2] > 235;
};
const isRed = (x, y) => {
  const p = at(x, y);
  return data[p] > 190 && data[p + 1] < 90 && data[p + 2] < 90;
};

// The page: the longest run of white in the middle of the canvas area.
let best = { x0: 0, x1: 0, width: 0 };
for (let y = 100; y < 900; y += 4) {
  let start = -1;
  for (let x = 340; x < 1680; x += 1) {
    if (isWhite(x, y)) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      if (x - start > best.width) best = { x0: start, x1: x, width: x - start };
      start = -1;
    }
  }
}
console.log(`page width at its widest: x ${best.x0}..${best.x1} (${best.width} px)`);

// The vertical extent of the page, in the middle column of the page.
let top = -1;
let bottom = -1;
const middle = Math.round((best.x0 + best.x1) / 2);
for (let y = 60; y < 940; y += 1) {
  if (isWhite(middle, y)) {
    if (top < 0) top = y;
    bottom = y;
  }
}
console.log(`page height: y ${top}..${bottom} (${bottom - top} px), middle column ${middle}`);

// The red rectangle.
let minX = 1e9;
let maxX = 0;
let minY = 1e9;
let maxY = 0;
for (let y = 100; y < 930; y += 1) {
  for (let x = 350; x < 1670; x += 1) {
    if (!isRed(x, y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}
console.log(`camera rectangle: x ${minX}..${maxX} (${maxX - minX} px), y ${minY}..${maxY} (${maxY - minY} px)`);

// Where the rectangle sits on the page, in page fractions.
const pageWidth = best.x1 - best.x0;
const pageHeight = bottom - top;
console.log(
  `the rectangle covers ${(((maxX - minX) / pageWidth) * 100).toFixed(2)}% of the width and ` +
    `${(((maxY - minY) / pageHeight) * 100).toFixed(2)}% of the height`,
);
console.log(
  `its centre is at ${(((minX + maxX) / 2 - best.x0) / pageWidth * 100).toFixed(2)}% of the width and ` +
    `${(((minY + maxY) / 2 - top) / pageHeight * 100).toFixed(2)}% of the height`,
);
