// Take the changes of a file and keep only the hunks that are wanted.
//   node tools/pick-hunks.mjs <file> <marker> [<marker>...]
// The result is written to the file <file>.pick.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [file, ...markers] = process.argv.slice(2);
const diff = execFileSync("git", ["diff", "-U3", "--", file], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const lines = diff.split("\n");
const header = [];
let index = 0;
while (index < lines.length && !lines[index].startsWith("@@")) {
  header.push(lines[index]);
  index += 1;
}

const hunks = [];
let current = null;
for (; index < lines.length; index += 1) {
  const line = lines[index];
  if (line.startsWith("@@")) {
    current = [line];
    hunks.push(current);
    continue;
  }
  if (current) current.push(line);
}

const kept = hunks.filter((hunk) => markers.some((marker) => hunk.join("\n").includes(marker)));
const out = [...header, ...kept.flat()].join("\n");
fs.writeFileSync(`${file}.pick`, out.endsWith("\n") ? out : `${out}\n`);
console.log(`${hunks.length} hunks, ${kept.length} kept`);
