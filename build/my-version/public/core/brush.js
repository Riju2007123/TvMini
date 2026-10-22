import { Buffer } from "./bytes.js";

/**
 * Finding the picture inside a brush file.
 *
 * A picture brush is a PNG. A Clip Studio Paint brush (a `.sut` file) is a
 * container that holds the picture of the brush, so the PNG is looked for
 * inside it. That way a brush that Clip Studio Paint wrote can be used
 * without the whole container having to be understood.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Where the PNG starts, or -1. */
function findPngStart(bytes, from) {
  for (let index = from; index + 8 <= bytes.length; index += 1) {
    let hit = true;
    for (let step = 0; step < 8; step += 1) {
      if (bytes[index + step] !== PNG_SIGNATURE[step]) {
        hit = false;
        break;
      }
    }
    if (hit) return index;
  }
  return -1;
}

/** Where the PNG ends, after its `IEND` chunk. */
function findPngEnd(bytes, from) {
  let index = from + 8;
  while (index + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(index);
    const type = bytes.toString("ascii", index + 4, index + 8);
    const next = index + 12 + length;
    if (type === "IEND") return next;
    if (next <= index) return -1;
    index = next;
  }
  return -1;
}

/**
 * The picture of a brush file.
 *
 * Returns the PNG bytes, or null when the file holds no picture.
 */
export function brushPngFromBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  // A file can hold more than one picture, and the signature can turn up
  // inside compressed data, so every one of them is tried and the first
  // that is a whole picture is taken.
  let index = findPngStart(bytes, 0);
  while (index !== -1) {
    if (bytes.toString("ascii", index + 12, index + 16) === "IHDR") {
      const end = findPngEnd(bytes, index);
      if (end > 0) return bytes.subarray(index, end);
    }
    index = findPngStart(bytes, index + 1);
  }
  return null;
}

/**
 * The picture of a brush file, as the base64 a drawing keeps.
 *
 * The picture is checked to be a PNG before it is taken, so a file that
 * holds something else is refused rather than quietly ignored.
 */
export function brushImageFromBytes(input) {
  const png = brushPngFromBytes(input);
  if (!png) return null;
  return { data: png.toString("base64"), bytes: png.length };
}

/**
 * Every picture in a file, the biggest one first.
 *
 * A file can hold a small picture of the shape and the shape itself, so the
 * biggest one is the one that is wanted.
 */
export function brushPngsFromBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const found = [];
  // A file can hold more than one picture, and the signature can turn up
  // inside compressed data, so every one of them is tried.
  let index = findPngStart(bytes, 0);
  while (index !== -1) {
    if (bytes.toString("ascii", index + 12, index + 16) === "IHDR") {
      const end = findPngEnd(bytes, index);
      if (end > 0) {
        found.push(bytes.subarray(index, end));
        index = findPngStart(bytes, end);
        continue;
      }
    }
    index = findPngStart(bytes, index + 1);
  }
  return found.sort((a, b) => b.length - a.length);
}

/**
 * The biggest picture in a file, or null when the file holds none.
 */
export function biggestBrushPngFromBytes(input) {
  return brushPngsFromBytes(input)[0] ?? null;
}
