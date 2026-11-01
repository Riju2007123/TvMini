/**
 * zlib-format deflate/inflate that works in both Node and the browser.
 *
 * Clip Studio's `.clip` blocks and PNG streams are both zlib (RFC 1950)
 * streams.
 *
 * Under Node the native `node:zlib` is used, so the Node build keeps
 * producing byte-identical files to the version that was validated in
 * Clip Studio Paint EX v3.0.0. In the browser there is no native zlib, so
 * the vendored MIT `fflate` package is used instead; it reads and writes the
 * same format.
 */
import { zlibSync, unzlibSync } from "../vendor/fflate.js";

const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);

let deflate = (bytes) => zlibSync(bytes, { level: 6 });
let inflate = (bytes) => unzlibSync(bytes);

// The level is 6, not 9: a `.clip` write deflates every tile of every layer,
// and the pure JavaScript deflate of fflate costs several times more at
// level 9 than at 6 for a few bytes more. Under Node the native zlib below
// takes the work over anyway.

if (isNode) {
  // The native zlib is picked up as soon as the module loads. Without an
  // await here the module also bundles into a CommonJS file (the standalone
  // exe), and until the swap lands the fflate functions are used, which
  // write the same zlib stream.
  import("node:zlib").then((nodeZlib) => {
    deflate = (bytes) => nodeZlib.deflateSync(bytes, { level: 9 });
    inflate = (bytes) => nodeZlib.inflateSync(bytes);
  });
}

/** Compress to a zlib stream. */
export function deflateSync(bytes) {
  return deflate(bytes);
}

/** Decompress a zlib stream. */
export function inflateSync(bytes) {
  return inflate(bytes);
}
