import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Open a document we wrote in the real Clip Studio Paint and check that it
 * draws what we meant it to draw.
 *
 *   node tools/clip-csp-verify.mjs [outdir]
 *
 * The check needs Clip Studio Paint, so it only runs on a machine that has
 * it. The comparison itself is exact: the paper of the document is a colour
 * that occurs nowhere else, the canvas is found in the picture of the
 * application by that colour, and every pixel of it is compared with the
 * picture this application renders.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = process.argv[2] ?? path.join(here, "..", "..", ".csp-check");
fs.mkdirSync(outdir, { recursive: true });

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

process.stdout.write(run(process.execPath, [path.join(here, "clip-csp-export.mjs"), outdir]));

const clip = path.join(outdir, "csp-check.clip");
const shot = path.join(outdir, "csp-shot.png");
const expected = path.join(outdir, "csp-expected.png");

run("powershell", [
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  path.join(here, "csp-capture.ps1"),
  "-ClipFile",
  clip,
  "-OutPng",
  shot,
  "-TimeoutSeconds",
  "120",
]);

process.stdout.write(
  run(process.execPath, [path.join(here, "clip-csp-compare.mjs"), shot, expected, "#ff00ff"]),
);
