/**
 * Export a project the way the program does when the project did not come
 * from a `.clip`: the bundled document with an animation in it is the
 * skeleton of the tracks.
 *
 *   node tools/clip-export-template.mjs <source.clip> <out.clip>
 */
import fs from "node:fs/promises";
import { readClipProject } from "../src/clip.js";
import { createClipBuffer } from "../src/clip-write.js";

const [source, out] = process.argv.slice(2);
const project = (await readClipProject(source)).project;
const written = await createClipBuffer(project, { name: "tvm", animation: true });
await fs.writeFile(out, Buffer.from(written.buffer));
console.log(`${out}: ${written.buffer.length} bytes, ${written.tracks} track(s)`);
