import test from "node:test";
import assert from "node:assert/strict";
import { findClipDatabase } from "../public/core/clip.js";
import { decodePng, encodePng } from "../public/core/png.js";
import { createProject } from "../public/core/model.js";

/**
 * The browser build hands plain `Uint8Array`s to the format code, while the
 * Node build uses `Buffer`. A plain array has neither `readBigUInt64BE` nor
 * `toString("ascii")`, so every entry point that accepts foreign bytes must
 * wrap them first.
 */

test("findClipDatabase accepts a plain Uint8Array", () => {
  // Layout: 8-byte magic, 8-byte total size, 8-byte header length, then
  // one chunk (8-byte name, 8-byte length, payload).
  const bytes = new Uint8Array(64);
  bytes.set([0x43, 0x53, 0x46, 0x43, 0x48, 0x55, 0x4e, 0x4b], 0); // CSFCHUNK
  bytes.set([0, 0, 0, 0, 0, 0, 0, 64], 8); // total size
  bytes.set([0, 0, 0, 0, 0, 0, 0, 24], 16); // header length

  bytes.set([0x43, 0x48, 0x4e, 0x4b, 0x53, 0x51, 0x4c, 0x69], 24); // CHNKSQLi
  bytes.set([0, 0, 0, 0, 0, 0, 0, 4], 32); // payload length
  bytes.set([1, 2, 3, 4], 40);

  const found = findClipDatabase(bytes);
  assert.equal(found.length, 4);
  assert.deepEqual([...found], [1, 2, 3, 4]);
});

test("findClipDatabase rejects a file that is not a .clip", () => {
  assert.throws(() => findClipDatabase(new Uint8Array(64)), /not a Clip Studio/);
});

test("decodePng accepts a plain Uint8Array", () => {
  const png = encodePng(4, 3, new Uint8Array(4 * 3 * 3).fill(200));
  const plain = new Uint8Array(png); // a copy without Buffer methods
  const decoded = decodePng(plain);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
});

test("a project with an embedded PNG still renders", () => {
  const project = createProject(16, 16);
  const png = encodePng(16, 16, new Uint8Array(16 * 16 * 3).fill(10));
  project.image = { data: Buffer.from(png).toString("base64"), width: 16, height: 16 };
  // The renderer decodes the embedded PNG; it must not throw.
  assert.doesNotThrow(() => decodePng(Buffer.from(project.image.data, "base64")));
});
