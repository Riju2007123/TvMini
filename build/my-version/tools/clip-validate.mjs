import fs from "node:fs";
import { Buffer } from "../public/core/bytes.js";
import { validateClipBytes } from "../public/core/clip-validate.js";

/**
 * Check the referential integrity of one or more `.clip` documents.
 *
 *   node tools/clip-validate.mjs file.clip [more.clip ...]
 *
 * Every pointer in the document has to resolve: the layer tree, the mipmap
 * chains, the thumbnails and the blobs. A `.clip` that does not satisfy
 * this does not fail in Clip Studio Paint - it opens and the layer is
 * empty - which is why it is worth checking before the file is handed to
 * anyone.
 *
 * The exit code is 1 when a document has a problem, so the check can be used
 * as a gate in a script.
 */
let failed = false;

for (const path of process.argv.slice(2)) {
  const bytes = fs.readFileSync(path);
  const result = await validateClipBytes(new Buffer(bytes));
  const label = `${path} (${result.stats.fileSize ?? bytes.length} bytes)`;
  if (result.ok) {
    console.log(
      `OK   ${label}: ${result.stats.layers} layers, ${result.stats.offscreens} offscreens, ${result.stats.externals} blobs`,
    );
  } else {
    failed = true;
    console.log(`FAIL ${label}`);
    for (const problem of result.problems) console.log(`       - ${problem}`);
  }
}

process.exit(failed ? 1 : 0);
