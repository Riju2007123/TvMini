import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { decodePng } from "../public/core/png.js";

/**
 * Compare a picture of Clip Studio Paint with the picture we expected.
 *
 *   node tools/clip-csp-compare.mjs csp.png expected.png [paper]
 *
 * The paper of the document is a colour that does not occur anywhere else,
 * so the canvas can be found in the picture by looking for that one colour.
 * The paper appears in more than one place - the canvas and the thumbnail
 * in the navigator - so the places that hold it are told apart by their
 * size: the canvas is the largest one, and it has to be exactly as large as
 * the document.
 *
 * The strokes lie on top of the paper, so the canvas is found as one piece
 * of paper with the strokes as holes, and the comparison leaves out the
 * pixels the strokes cover.
 */
const [screenshotPath, expectedPath] = process.argv.slice(2);
const paper = process.argv[4] ?? "#ff00ff";
const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(paper.slice(i, i + 2), 16));

const shot = decodePng(new Buffer(fs.readFileSync(screenshotPath)));
const want = decodePng(new Buffer(fs.readFileSync(expectedPath)));

if (shot.width < want.width || shot.height < want.height) {
  console.log(`FAIL: the picture is ${shot.width}x${shot.height}, too small for ${want.width}x${want.height}`);
  process.exit(1);
}

const isPaper = new Uint8Array(shot.width * shot.height);
for (let i = 0; i < shot.width * shot.height; i += 1) {
  const p = i * 4;
  if (shot.data[p] === pr && shot.data[p + 1] === pg && shot.data[p + 2] === pb) isPaper[i] = 1;
}

// The largest piece of paper. The canvas is the biggest one; the thumbnail
// in the navigator is much smaller.
let best = null;
const seen = new Uint8Array(shot.width * shot.height);
const stack = [];
for (let start = 0; start < isPaper.length; start += 1) {
  if (!isPaper[start] || seen[start]) continue;
  seen[start] = 1;
  stack.length = 0;
  stack.push(start);
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  while (stack.length) {
    const at = stack.pop();
    const x = at % shot.width;
    const y = (at - x) / shot.width;
    count += 1;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (x > 0 && isPaper[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; stack.push(at - 1); }
    if (x < shot.width - 1 && isPaper[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; stack.push(at + 1); }
    if (y > 0 && isPaper[at - shot.width] && !seen[at - shot.width]) { seen[at - shot.width] = 1; stack.push(at - shot.width); }
    if (y < shot.height - 1 && isPaper[at + shot.width] && !seen[at + shot.width]) { seen[at + shot.width] = 1; stack.push(at + shot.width); }
  }
  if (!best || count > best.count) best = { count, minX, minY, maxX, maxY };
}

const boxWidth = best.maxX - best.minX + 1;
const boxHeight = best.maxY - best.minY + 1;
console.log(
  `the largest piece of paper ${paper}: ${boxWidth}x${boxHeight} at ${best.minX},${best.minY} (${best.count} pixels)`,
);

if (boxWidth !== want.width || boxHeight !== want.height) {
  console.log(
    `FAIL: the canvas in the picture is ${boxWidth}x${boxHeight}, the document is ${want.width}x${want.height}`,
  );
  process.exit(1);
}

// Compare the canvas with the expected picture. The strokes cover part of
// the paper, so those pixels are left out of the comparison.
let worst = 0;
let compared = 0;
let skipped = 0;
const offenders = [];
for (let y = 0; y < want.height; y += 1) {
  for (let x = 0; x < want.width; x += 1) {
    const s = ((best.minY + y) * shot.width + (best.minX + x)) * 4;
    const w = (y * want.width + x) * 4;
    if (shot.data[s] !== pr || shot.data[s + 1] !== pg || shot.data[s + 2] !== pb) {
      skipped += 1;
      continue;
    }
    compared += 1;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(shot.data[s + c] - want.data[w + c]);
      if (d > worst) {
        worst = d;
        if (offenders.length < 6) {
          offenders.push(`  ${x},${y} channel ${c}: ${shot.data[s + c]} vs ${want.data[w + c]}`);
        }
      }
    }
  }
}

console.log(`compared ${compared} paper pixels, skipped ${skipped} covered by the strokes`);
if (worst === 0) {
  console.log("=> the canvas Clip Studio Paint drew is the canvas we meant to draw");
  process.exit(0);
}
console.log(`max difference: ${worst}`);
for (const line of offenders) console.log(line);
console.log("=> the canvas does not match");
process.exit(1);
