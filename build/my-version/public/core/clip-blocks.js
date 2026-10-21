import { Buffer } from "./bytes.js";
import { deflateSync, inflateSync } from "./zlib.js";
import { ValidationError } from "./model.js";

/**
 * The block codec shared by the `.clip` reader and writer.
 *
 * Clip Studio Paint stores a raster layer as a grid of fixed-size tiles.
 * Every tile is one record inside the `CHNKExta` chunk that holds the layer's
 * block data, and the tile bytes are a zlib stream.
 *
 * The layout below was read out of real Clip Studio Paint 1.5 documents and
 * confirmed against the shipped `CLIPStudio.exe`; see
 * `docs/clip-format-study.md` for the full method and the evidence behind
 * every field.
 */

/** The edge length of one square tile, in pixels. */
export const BLOCK_SIZE = 256;

/**
 * The number of extra rows the colour data is stored with.
 *
 * CSP keeps the alpha channel in a separate 64x64 grid of 4x4 super-pixels
 * that is folded into the first 64 rows of the same buffer.
 */
export const ALPHA_TILE = 64;

/** The size of a record that carries no pixels. */
export const EMPTY_RECORD_SIZE = 104;

/** The key that opens a block record, UTF-16 big endian. */
export const BLOCK_BEGIN = Buffer.from("BlockDataBeginChunk", "utf16le").swap16();

/** The key that closes a block record, UTF-16 big endian. */
export const BLOCK_END = Buffer.from("BlockDataEndChunk", "utf16le").swap16();

export function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

export function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

export function utf16be(value) {
  return Buffer.from(value, "utf16le").swap16();
}

export function writeU32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

/**
 * Split the `Offscreen.Attribute` blob into its four sections.
 *
 * The blob starts with the four section sizes as big-endian 32-bit numbers.
 * The first size is the size of the size table itself, so the sections
 * follow it one after another.
 */
export function splitAttribute(attribute) {
  const sizes = [0, 1, 2, 3].map((index) => attribute.readUInt32BE(index * 4));
  let offset = sizes[0];
  const sections = [];
  for (let index = 1; index < 4; index += 1) {
    if (offset + sizes[index] > attribute.length) {
      throw new ValidationError("the .clip offscreen description is damaged");
    }
    sections.push(attribute.subarray(offset, offset + sizes[index]));
    offset += sizes[index];
  }
  if (offset !== attribute.length) {
    throw new ValidationError("the .clip offscreen description is damaged");
  }
  return { sizes, sections };
}

export function joinAttribute(sections) {
  return Buffer.concat([
    u32(16),
    ...sections.map((section) => u32(section.length)),
    ...sections,
  ]);
}

/**
 * Read the pieces of `Offscreen.Attribute` that describe a raster.
 *
 * `sizes[2]` holds the block table: the tile size, the number of tiles, the
 * channel count and then the byte length of every tile record.
 */
export function parseAttribute(attribute) {
  const { sections } = splitAttribute(attribute);
  const [parameter, initColor, blockSize] = sections;
  const values = [];
  for (let index = 0; index < 20; index += 1) {
    values.push(parameter.readUInt32BE(22 + index * 4));
  }
  const blockMagic = blockSize.readUInt32BE(22);
  const blockCount = blockSize.readUInt32BE(26);
  const channels = blockSize.readUInt32BE(30);
  const blockSizes = [];
  for (let index = 0; index < blockCount; index += 1) {
    blockSizes.push(blockSize.readUInt32BE(34 + index * 4));
  }

  const initMagic = initColor.readUInt32BE(22);
  const hasInitColor = initColor.readUInt32BE(26) !== 0;
  const initPacked = initColor.readUInt32BE(30);
  const extraColors = initColor.readUInt32BE(34);
  const initChannels = initColor.readUInt32BE(38);

  return {
    width: values[0],
    height: values[1],
    cols: values[2],
    rows: values[3],
    colorMode: values[4],
    numChannels: values[6],
    bitDepth: values[7],
    blockHeight: values[14],
    blockWidth: values[15],
    blockMagic,
    blockCount,
    blockChannels: channels,
    blockSizes,
    initMagic,
    hasInitColor,
    initPacked,
    extraColors,
    initChannels,
  };
}

/**
 * Pack one tile of RGBA into the buffer CSP stores.
 *
 * The colour channels are written as rows `ALPHA_TILE`..`ALPHA_TILE+height`,
 * and the alpha channel is folded into the first `ALPHA_TILE` rows as a grid
 * of 4x4 super-pixels: the alpha of the source pixel `(y*4+tile,
 * column*4+channel)` lives at `(tile*64+column)*4+channel` in row `y`.
 */
export function encodeRgbaBlock(rgba, width, height) {
  const output = Buffer.alloc((height + ALPHA_TILE) * width * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = ((y + ALPHA_TILE) * width + x) * 4;
      output[target] = rgba[source + 2];
      output[target + 1] = rgba[source + 1];
      output[target + 2] = rgba[source];
      output[target + 3] = rgba[source + 3];
    }
  }

  for (let y = 0; y < ALPHA_TILE; y += 1) {
    for (let tile = 0; tile < 4; tile += 1) {
      for (let column = 0; column < ALPHA_TILE; column += 1) {
        for (let channel = 0; channel < 4; channel += 1) {
          const sourceY = y * 4 + tile;
          const sourceX = column * 4 + channel;
          const target = (y * width + tile * ALPHA_TILE + column) * 4 + channel;
          output[target] = rgba[(sourceY * width + sourceX) * 4 + 3];
        }
      }
    }
  }
  return output;
}

/**
 * Unpack one tile CSP stored, the inverse of `encodeRgbaBlock`.
 *
 * CSP keeps the colour channels in blue, green, red order inside a tile, so
 * the red and blue bytes are swapped back here. The result is straight RGBA
 * in row order.
 */
export function decodeRgbaBlock(raw, width, height) {
  const output = Buffer.alloc(width * height * 4);
  const stride = width * 4;

  // A tile comes in one of two layouts. Most carry the alpha folded into the
  // first `ALPHA_TILE` rows above the colour rows, so the buffer is
  // `height + ALPHA_TILE` rows tall. Some are plain RGBA of the tile itself,
  // with the alpha already in every pixel. The length says which is which.
  const folded = raw.length >= (height + ALPHA_TILE) * stride;
  const start = folded ? ALPHA_TILE * stride : 0;
  const rows = Math.min(height, Math.max(0, Math.floor((raw.length - start) / stride)));

  for (let y = 0; y < rows; y += 1) {
    raw.copy(output, y * stride, start + y * stride, start + y * stride + stride);
  }
  for (let index = 0; index < rows * width; index += 1) {
    const target = index * 4;
    const red = output[target + 2];
    output[target + 2] = output[target];
    output[target] = red;
  }
  if (!folded) return output;

  for (let sourceY = 0; sourceY < rows; sourceY += 1) {
    // The writer folds the alpha of the source pixel (y*4+tile,
    // column*4+channel) into row `y` at the tile offset `tile`, so the row
    // is the high half of the source row and the tile the low half.
    const row = sourceY >> 2;
    const tile = sourceY & 3;
    for (let sourceX = 0; sourceX < width; sourceX += 1) {
      const column = sourceX >> 2;
      const channel = sourceX & 3;
      const at = (row * width + tile * ALPHA_TILE + column) * 4 + channel;
      if (at >= raw.length) continue;
      output[(sourceY * width + sourceX) * 4 + 3] = raw[at];
    }
  }
  return output;
}

/**
 * Build the record that holds one tile.
 *
 * The record opens with its own size and the length of its key in
 * characters, then the key itself, then the tile header. A tile with pixels
 * adds the compressed size, the compressed length again as a little-endian
 * number and the zlib stream.
 */
export function buildBlockRecord(index, raw, width, height) {
  const decompressed = (height + ALPHA_TILE) * width * 4;
  const tail = Buffer.concat([u32(17), BLOCK_END]);
  if (!raw) {
    return Buffer.concat([
      u32(EMPTY_RECORD_SIZE),
      u32(19),
      BLOCK_BEGIN,
      u32(index),
      u32(decompressed),
      u32(width),
      u32(height),
      u32(0),
      tail,
    ]);
  }

  const compressed = deflateSync(raw);
  return Buffer.concat([
    u32(compressed.length + 112),
    u32(19),
    BLOCK_BEGIN,
    u32(index),
    u32(decompressed),
    u32(width),
    u32(height),
    u32(1),
    u32(compressed.length + 4),
    writeU32LE(compressed.length),
    compressed,
    tail,
  ]);
}

/**
 * The two trailer properties CSP writes after the tile records.
 *
 * `BlockStatus` says which tiles hold pixels and `BlockCheckSum` holds a
 * per-tile checksum.
 */
export function buildTrailers(count) {
  const parts = [];
  for (const [name, value] of [
    ["BlockStatus", 1],
    ["BlockCheckSum", 0],
  ]) {
    parts.push(
      u32(name.length),
      utf16be(name),
      u32(12),
      u32(count),
      u32(4),
      ...Array(count).fill(u32(value)),
    );
  }
  return Buffer.concat(parts);
}

/**
 * Walk the tile records inside a `CHNKExta` payload.
 *
 * The payload opens with the external locator (a 40 byte header, the id
 * text and the length of what follows) and then the tile records, each one
 * introduced by its own size and the length of its key.
 */
export function readBlockRecords(payload) {
  const records = [];
  let cursor = 56;
  while (cursor + 8 <= payload.length) {
    const size = payload.readUInt32BE(cursor);
    if (size === 0) break;
    if (cursor + size > payload.length) break;
    const keyLength = payload.readUInt32BE(cursor + 4);
    const keyBytes = keyLength * 2;
    const key = payload.subarray(cursor + 8, cursor + 8 + keyBytes);
    if (key.equals(BLOCK_BEGIN)) {
      const base = cursor + 8 + keyBytes;
      records.push({
        index: payload.readUInt32BE(base),
        decompressedSize: payload.readUInt32BE(base + 4),
        width: payload.readUInt32BE(base + 8),
        height: payload.readUInt32BE(base + 12),
        hasData: payload.readUInt32BE(base + 16) !== 0,
        compressedSize: payload.readUInt32BE(base + 20),
        dataOffset: base + 28,
      });
    }
    cursor += size;
  }
  return records;
}

/**
 * Decode every tile of a `CHNKExta` payload into one RGBA canvas.
 *
 * `info` is the `Offscreen.Attribute` description of the raster. Tiles that
 * carry no pixels stay transparent.
 */
export function decodeBlockPayload(payload, info) {
  const pixels = Buffer.alloc(info.width * info.height * 4);
  const records = readBlockRecords(payload);
  let decoded = 0;
  for (const record of records) {
    if (!record.hasData) continue;
    const compressed = payload.subarray(
      record.dataOffset,
      record.dataOffset + record.compressedSize - 4,
    );
    let raw;
    try {
      raw = inflateSync(compressed);
    } catch {
      continue;
    }
    const tile = decodeRgbaBlock(raw, record.width, record.height);
    const row = Math.floor(record.index / info.cols);
    const column = record.index % info.cols;
    const copyWidth = Math.min(record.width, info.width - column * info.blockWidth);
    const copyHeight = Math.min(record.height, info.height - row * info.blockHeight);
    for (let y = 0; y < copyHeight; y += 1) {
      tile.copy(
        pixels,
        ((row * info.blockHeight + y) * info.width + column * info.blockWidth) * 4,
        (y * record.width) * 4,
        (y * record.width) * 4 + copyWidth * 4,
      );
    }
    decoded += 1;
  }
  return { pixels, records: records.length, decoded };
}


