/**
 * Export a .clip and read it back, to see whether the timeline survives.
 *
 *   node tools/clip-roundtrip.mjs [file]
 *
 * The file is imported, exported again, and imported once more. The two
 * projects are compared: the rate of the timeline, and the frame and the
 * length of every cell. A file that loses its timing opens in Clip Studio
 * Paint but does not play.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readClipProject } from "../src/clip.js";
import { exportClip } from "../src/store.js";

const FILE = process.argv[2] ?? "C:\\Users\\MK\\Documents\\Animation3.clip";
const OUT = path.join(os.tmpdir(), "tvmini-clip-roundtrip.clip");

const cells = (project) => {
  const out = [];
  project.layers.forEach((layer, index) => {
    for (const drawing of layer.drawings ?? []) {
      out.push({
        layer: index,
        name: layer.name,
        at: drawing.at,
        hold: drawing.hold,
        strokes: (drawing.strokes ?? []).length,
        picture: Boolean(drawing.image),
      });
    }
  });
  return out;
};

const first = await readClipProject(FILE);
console.log(`the file: ${FILE}`);
console.log(
  `  ${first.project.layers.length} layers, ${cells(first.project).length} cells,` +
    ` ${first.project.fps} fps, start ${first.project.startFrame},` +
    ` last ${Math.max(...cells(first.project).map((cell) => cell.at + cell.hold - 1))}`,
);

await exportClip(OUT, first.project, FILE);
const bytes = (await fs.stat(OUT)).size;
console.log(`\nthe export: ${OUT} (${bytes} bytes)`);

const second = await readClipProject(OUT);
const before = cells(first.project);
const after = cells(second.project);
console.log(
  `  read back: ${second.project.layers.length} layers, ${after.length} cells,` +
    ` ${second.project.fps} fps, start ${second.project.startFrame},` +
    ` last ${Math.max(...after.map((cell) => cell.at + cell.hold - 1))}`,
);

let same = 0;
const problems = [];
for (const cell of before) {
  const match = after.find(
    (other) =>
      other.layer === cell.layer &&
      other.at === cell.at &&
      other.hold === cell.hold &&
      other.strokes === cell.strokes &&
      other.picture === cell.picture,
  );
  if (match) same += 1;
  else problems.push({ before: cell, after: after.filter((other) => other.layer === cell.layer) });
}
console.log(`\n  ${same} of ${before.length} cells came back exactly the same`);
for (const problem of problems.slice(0, 12)) {
  const cell = problem.before;
  console.log(
    `    layer ${cell.layer} "${cell.name}": was at ${cell.at}, hold ${cell.hold},` +
      ` ${cell.strokes} stroke(s), picture ${cell.picture ? "yes" : "no"}`,
  );
  for (const other of problem.after) {
    console.log(
      `        -> now at ${other.at}, hold ${other.hold}, ${other.strokes} stroke(s),` +
        ` picture ${other.picture ? "yes" : "no"}`,
    );
  }
}
if (problems.length > 12) console.log(`    ... and ${problems.length - 12} more`);

const beforeRate = first.document.timeline?.frameRate;
const afterRate = second.document.timeline?.frameRate;
console.log(
  `\n  the rate in the file: ${beforeRate} -> ${afterRate}` +
    `, the frames of the timeline: ${first.document.timeline?.startFrame}..${first.document.timeline?.endFrame}` +
    ` -> ${second.document.timeline?.startFrame}..${second.document.timeline?.endFrame}`,
);

await fs.rm(OUT, { force: true });
