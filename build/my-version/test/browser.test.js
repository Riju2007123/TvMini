import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

/** Every browser file, except the vendored libraries. */
async function browserFiles(dir = publicDir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await browserFiles(full)));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found;
}

/**
 * The browser files have to parse.
 *
 * The rest of the tests run the code under Node, and the browser files are
 * only ever loaded by the browser, so a mistake in one of them is invisible
 * to the suite: the page still looks right, but nothing works, because the
 * script never ran. This checks that every one of them parses.
 */
test("every browser file parses", async () => {
  const files = await browserFiles();
  assert.ok(files.length > 10, "the browser files should have been found");
  const broken = [];
  for (const file of files) {
    try {
      await run(process.execPath, ["--check", file]);
    } catch (error) {
      broken.push(`${path.relative(publicDir, file)}: ${String(error.stderr || error).split("\n")[0]}`);
    }
  }
  assert.deepEqual(broken, []);
});
