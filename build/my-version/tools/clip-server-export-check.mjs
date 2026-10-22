/**
 * Export a .clip through a running TVMini server, the way the browser does.
 *
 *   node tools/clip-server-export-check.mjs [port] [outPath]
 */
import fs from "node:fs/promises";
import { createProject } from "../public/core/model.js";
import { readClipDocument } from "../src/clip.js";

const port = Number(process.argv[2] ?? 4123);
const out = process.argv[3] ?? "tvmini-server-check.clip";

const stroke = (color, from, to, width = 14) => ({ color, width, points: [from, to] });

const project = createProject(480, 270);
project.fps = 24;
project.layers = [
  {
    name: "Row One",
    type: "anim",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    preBehavior: "hold",
    postBehavior: "hold",
    clip: false,
    parent: -1,
    drawings: [
      { at: 1, hold: 4, name: "one", strokes: [stroke("#e04030", [60, 60], [200, 60])] },
      { at: 5, hold: 4, name: "two", strokes: [stroke("#30a0e0", [60, 100], [200, 100])] },
      { at: 9, hold: 4, name: "three", strokes: [stroke("#30b060", [60, 140], [200, 140])] },
    ],
  },
];

const response = await fetch(`http://127.0.0.1:${port}/api/export-clip`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: out, project }),
});
const result = await response.json();
console.log(`HTTP ${response.status}`, JSON.stringify(result));

const written = result.path ?? out;
const bytes = await fs.stat(written);
console.log(`written: ${written} (${bytes.size} bytes)`);
const document = await readClipDocument(written);
console.log(`timeline: ${JSON.stringify(document.timeline)}`);
console.log(`tracks: ${(document.tracks ?? []).map((track) => track.kind).join(",")}`);
for (const track of document.tracks ?? []) {
  const action = track.action2;
  const keys = action?.celKeys ?? [];
  if (keys.length) {
    console.log(
      `  track ${track.mainId}: ${keys.map((key) => `${key.tag}@${key.time}`).join(" ")}` +
        ` range ${JSON.stringify(action.clipRange)}`,
    );
  }
}
