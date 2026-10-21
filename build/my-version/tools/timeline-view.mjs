/**
 * What the timeline of the application shows for a .clip.
 *
 *   node tools/timeline-view.mjs file.clip
 *
 * The rows and the cells are worked out the way the application works them
 * out, so the picture of the timeline can be checked without the screen.
 */
import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { clipToProject, readClipDocumentFromBytes, readClipLayersFromBytes } from "../public/core/clip.js";
import { childrenOf, isGroup, layerDepth } from "../public/timeline.js";

const data = Buffer.from(fs.readFileSync(process.argv[2]));
const document = await readClipDocumentFromBytes(data);
const layers = await readClipLayersFromBytes(data, { includePaper: true });
const project = clipToProject(document, layers, {});

/** The cells a folder shows, the way the application works them out. */
function folderCells(groupIndex) {
  const cells = new Map();
  for (const child of childrenOf(project, groupIndex)) {
    const layer = project.layers[child];
    for (const drawing of layer.drawings ?? []) {
      for (let offset = 0; offset < drawing.hold; offset += 1) {
        const frame = drawing.at + offset;
        if (cells.has(frame)) continue;
        cells.set(frame, {
          layer: child,
          name: offset === 0 ? drawing.name : null,
          count: drawing.hold,
        });
      }
    }
  }
  return cells;
}

const walk = (parent, depth) => {
  for (const child of childrenOf(project, parent)) {
    const layer = project.layers[child];
    const indent = "  ".repeat(depth);
    if (isGroup(layer)) {
      const cells = folderCells(child);
      const list = [...cells.entries()]
        .map(([frame, entry]) => `${entry.name ?? "·"}@${frame}`)
        .join(" ");
      console.log(`${indent}${layer.name}  [folder] cells: ${list || "(none)"}`);
    } else {
      const list = (layer.drawings ?? [])
        .map((drawing) => `${drawing.name ?? "·"}@${drawing.at}+${drawing.hold}`)
        .join(" ");
      console.log(`${indent}${layer.name}  ${list}`);
    }
    walk(child, depth + 1);
  }
};
walk(-1, 0);
