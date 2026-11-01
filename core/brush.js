import { Buffer } from "./bytes.js";

/** PNG signature bytes: 89 50 4e 47 0d 0a 1a 0a */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Flash 8 brush smoothness constants.
 *
 * BRUSH_Draw reads +0x230 for smoothing value.
 * Threshold 0x10000 (65536) when 40 <= smoothness <= 60,
 * otherwise 0x1000000 (16777216).
 * When smoothness > 12, brush tip is rasterised and
 * CURVE_SmoothHelper(..., (smoothness-40)*3/2, 0, 0) is called.
 * BRUSH_SmoothScale(smoothness * 0.1) scales RGB colour
 * by smoothness * 0.2.
 * Rasterisation tolerance: constant 0x1e0000 (196608).
 */

export const FLASH8 = {
  /** Smoothness threshold: smooth path vs rasterise */
  SMOOTH_THRESHOLD_LOW: 0x10000, // 65536
  SMOOTH_THRESHOLD_HIGH: 0x1000000, // 16777216
  /** Derived smoothing value for CURVE_SmoothHelper */
  SMOOTH_DERIVED_SCALE: 3 / 2,
  /** BRUSH_SmoothScale factor */
  SMOOTH_SCALE_FACTOR: 0.1,
  /** RGB colour scaling factor */
  SMOOTH_RGB_SCALE: 0.2,
  /** Rasterisation tolerance */
  RASTER_TOLERANCE: 0x1e0000, // 196608
  /** Default smoothness */
  SMOOTHNESS_DEFAULT: 50,
};

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
