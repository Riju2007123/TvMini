/**
 * Import a `.clip`, write it back, and compare the two documents in detail.
 *
 *   node tools/clip-roundtrip-check.mjs <file> [more files]
 *
 * The file is imported, exported again the way the program exports it (the
 * file it came from is the skeleton of the tracks), and imported once more.
 * The two projects are then compared: the canvas, the timeline, every layer
 * with its folder, its place in the tree and every cell it holds, and the
 * kinds of the tracks the document has.
 *
 * A difference here is a difference a person would see in Clip Studio Paint:
 * a cell that starts on another frame, or a layer that moved in the tree.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readClipDocument, readClipProject } from "../src/clip.js";
import { exportClip } from "../src/store.js";

const TEMP = path.join(os.tmpdir(), "tvmini-roundtrip");
const KEEP = process.argv.includes("--keep");

/** The things of a project that a person can see. */
/**
 * The things of a project that a person can see.
 *
 * The transform of a cell is not part of it: a `.clip` has no layer of its
 * own for a turn or a size, so the writer puts the picture where the
 * transform says. The two documents therefore look the same even though one
 * of them carries the transform and the other does not.
 */
const shape = (project) => ({
  fps: project.fps,
  start: project.startFrame,
  current: project.currentFrame,
  width: project.width,
  height: project.height,
  background: project.background,
  layers: project.layers.map((layer) =>
    [
      layer.type === "group" ? "F" : "L",
      layer.name,
      layer.parent,
      layer.visible,
      layer.opacity,
      (layer.drawings ?? [])
        .map((drawing) => `${drawing.at}x${drawing.hold}${drawing.name ? `(${drawing.name})` : ""}`)
        .join(" "),
    ].join("|"),
  ),
});

const kinds = (document) => (document.tracks ?? []).map((track) => track.kind).join(",");

for (const file of process.argv.slice(2).filter((argument) => !argument.startsWith("--"))) {
  const before = await readClipProject(file);
  const beforeDocument = await readClipDocument(file);
  const project = before.project;

  const out = path.join(TEMP, `${path.basename(file, ".clip")}.roundtrip.clip`);
  await fs.mkdir(TEMP, { recursive: true });
  const started = Date.now();
  await exportClip(out, project, file);
  const writeMs = Date.now() - started;

  const after = await readClipProject(out);
  const afterDocument = await readClipDocument(out);

  const a = shape(project);
  const b = shape(after.project);
  const differences = [];
  for (const field of ["fps", "start", "current", "width", "height", "background"]) {
    if (a[field] !== b[field]) differences.push(`${field}: ${a[field]} -> ${b[field]}`);
  }
  const count = Math.max(a.layers.length, b.layers.length);
  for (let index = 0; index < count; index += 1) {
    if (a.layers[index] !== b.layers[index]) {
      differences.push(`layer ${index}\n     was: ${a.layers[index]}\n     now: ${b.layers[index]}`);
    }
  }

  const size = (await fs.stat(out)).size;
  console.log(`\n${path.basename(file)}  (${size} bytes, written in ${writeMs} ms)`);
  console.log(
    `  timeline ${JSON.stringify(beforeDocument.timeline)}`,
  );
  console.log(`       ->  ${JSON.stringify(afterDocument.timeline)}`);
  console.log(`  layers ${a.layers.length} -> ${b.layers.length}`);
  console.log(`  tracks ${kinds(beforeDocument)}\n       -> ${kinds(afterDocument)}`);
  console.log(`  differences: ${differences.length}`);
  for (const difference of differences.slice(0, 12)) console.log(`    ${difference}`);
  if (differences.length > 12) console.log(`    ... and ${differences.length - 12} more`);
  if (!KEEP) await fs.rm(out, { force: true });
  else console.log(`  kept: ${out}`);
}
