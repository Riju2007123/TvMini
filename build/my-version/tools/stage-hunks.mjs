/**
 * Stage only the hunks that belong to this change.
 *
 * Another program is working in the same tree, so a file can hold work that
 * is not ready yet. This takes the diff of a file, keeps the hunks that
 * mention a marker, and puts them in the index - the rest stays in the
 * working tree.
 *
 *   node tools/stage-hunks.mjs <file> <marker> [more files and markers]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const files = [];
for (let index = 0; index < args.length; index += 2) files.push([args[index], args[index + 1]]);

const chunks = [];
for (const [file, marker] of files) {
  const diff = execFileSync("git", ["diff", "-U2", "--", file], { encoding: "utf8" });
  const lines = diff.split("\n");
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      current = [line];
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) header.push(line);
      continue;
    }
    current.push(line);
  }
  const kept = hunks.filter((hunk) => hunk.some((line) => line.includes(marker)));
  if (!kept.length) {
    console.log(`${file}: nothing matched ${marker}`);
    continue;
  }
  console.log(`${file}: ${kept.length} of ${hunks.length} hunk(s) kept`);
  chunks.push([...header, ...kept.flat()].join("\n"));
}

const patch = chunks.join("\n");
const file = process.env.TMPDIR ? process.env.TMPDIR + "/hunks.patch" : "hunks.patch";
fs.writeFileSync(file, patch);
console.log(`patch written to ${file}`);
execFileSync("git", ["apply", "--cached", "--whitespace=nowarn", file], { stdio: "inherit" });
console.log("staged");
