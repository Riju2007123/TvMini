/**
 * Byte helpers that work in both Node and the browser.
 *
 * Node has a native `Buffer`; the browser does not, so the web build loads a
 * small MIT-licensed polyfill from `../vendor/buffer.js`. Both expose the same
 * API for everything this project uses, so the format code below is identical
 * on both sides.
 */
import { Buffer as PolyfillBuffer } from "../vendor/buffer.js";

/** Native `Buffer` when available, otherwise the browser polyfill. */
export const Buffer = globalThis.Buffer ?? PolyfillBuffer;
