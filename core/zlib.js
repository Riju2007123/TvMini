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
 *
 * The answer of both helpers is always a `Buffer`, never the bare
 * `Uint8Array` fflate hands over: the readers of the tiles copy their rows
 * with `Buffer.copy`, and a plain array view has no such method - a `.clip`
 * imported in the browser would die with "raw.copy is not a function" in the
 * middle of its first painted layer.
 *
 * `deflateSync` takes `options.level`: the default writes files as small as
 * the readers of the formats expect, and an importer that only keeps
 * pictures in memory passes a lower level to spend its seconds on the user
 * instead of on a few kilobytes of file.
 */
import { zlibSync, unzlibSync } from "../vendor/fflate.js";
import { Buffer } from "./bytes.js";

const isNode = typeof process !== "undefined" && Boolean(process.versions?.node);

const LEVEL_NODE = 9;
const LEVEL_BROWSER = 6;

let deflate = (bytes, options = {}) =>
  Buffer.from(zlibSync(bytes, { level: options.level ?? LEVEL_BROWSER }));
let inflate = (bytes) => Buffer.from(unzlibSync(bytes));

if (isNode) {
  // The native zlib is picked up as soon as the module loads. Without an
  // await here the module also bundles into a CommonJS file (the standalone
  // exe), and until the swap lands the fflate functions are used, which
  // write the same zlib stream.
  import("node:zlib").then((nodeZlib) => {
    deflate = (bytes, options = {}) =>
      nodeZlib.deflateSync(bytes, { level: options.level ?? LEVEL_NODE });
    inflate = (bytes) => nodeZlib.inflateSync(bytes);
  });
}

/** Compress to a zlib stream. */
export function deflateSync(bytes, options = {}) {
  return deflate(bytes, options);
}

/** Decompress a zlib stream. */
export function inflateSync(bytes) {
  return inflate(bytes);
}
