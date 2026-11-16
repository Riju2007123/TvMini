/**
 * Still-image readers and writers for the formats a drawing app trades in:
 * BMP and TGA (both public, simple formats), plus a sniffing `decodeImage`
 * that also takes PNG, GIF and Flash's lossless `.dat` bitmap container
 * (the form Animate keeps uncompressed library bitmaps in, inside an XFL's
 * `bin/` folder).
 *
 * Everything decodes to straight-alpha RGBA, `{ width, height, data }`.
 * JPEG is not decoded here: it needs a full DCT decoder, and the browser
 * build already has one built in. A JPEG is reported as unsupported.
 */
import { Buffer } from "./bytes.js";
import { decodeGif } from "./gif.js";
import { decodePng } from "./png.js";
import { inflateSync } from "./zlib.js";

const MAX_PIXELS = 64_000_000;

function checkSize(width, height) {
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) {
    throw new Error(`unsupported image size ${width}×${height}`);
  }
}

/** Read a BMP: 8, 24 or 32 bits per pixel, uncompressed or bitfields. */
export function decodeBmp(input) {
  const b = Buffer.from(input);
  if (b.length < 26 || b.toString("latin1", 0, 2) !== "BM") throw new Error("not a BMP file");
  const dataOffset = b.readUInt32LE(10);
  const headerSize = b.readUInt32LE(14);
  if (headerSize < 40) throw new Error("unsupported BMP header");
  const width = b.readInt32LE(18);
  const rawHeight = b.readInt32LE(22);
  const bits = b.readUInt16LE(28);
  const compression = b.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  checkSize(width, height);
  if (compression !== 0 && compression !== 3) throw new Error("compressed BMP files are not supported");
  if (![8, 24, 32].includes(bits)) throw new Error(`${bits}-bit BMP files are not supported`);

  let palette = null;
  if (bits === 8) {
    const used = b.readUInt32LE(46) || 256;
    palette = [];
    for (let i = 0; i < used; i += 1) {
      const at = 14 + headerSize + i * 4;
      palette.push([b[at + 2], b[at + 1], b[at]]);
    }
  }
  let alphaMask = false;
  if (bits === 32) {
    // With BI_RGB the fourth byte is usually padding; trust it only when
    // some pixel actually uses it.
    for (let i = 0; i < width * height && !alphaMask; i += 1) {
      const row = Math.floor(i / width);
      const col = i % width;
      if (b[dataOffset + (row * width + col) * 4 + 3] !== 0) alphaMask = true;
    }
  }

  const stride = Math.ceil((width * bits) / 32) * 4;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const y = rawHeight > 0 ? height - 1 - row : row;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      const at = dataOffset + row * stride;
      if (bits === 8) {
        const color = palette[b[at + x]] ?? [0, 0, 0];
        data.set(color, out);
        data[out + 3] = 255;
      } else if (bits === 24) {
        data[out] = b[at + x * 3 + 2];
        data[out + 1] = b[at + x * 3 + 1];
        data[out + 2] = b[at + x * 3];
        data[out + 3] = 255;
      } else {
        data[out] = b[at + x * 4 + 2];
        data[out + 1] = b[at + x * 4 + 1];
        data[out + 2] = b[at + x * 4];
        data[out + 3] = alphaMask ? b[at + x * 4 + 3] : 255;
      }
    }
  }
  return { width, height, data };
}

/** Read a TGA: truecolour (24/32 bit) or grey (8 bit), raw or RLE. */
export function decodeTga(input) {
  const b = Buffer.from(input);
  if (b.length < 18) throw new Error("not a TGA file");
  const idLength = b[0];
  const colorMapType = b[1];
  const type = b[2];
  const mapLength = b.readUInt16LE(5);
  const mapBits = b[7];
  const width = b.readUInt16LE(12);
  const height = b.readUInt16LE(14);
  const bits = b[16];
  const descriptor = b[17];
  if (![2, 3, 10, 11].includes(type)) throw new Error("this TGA type is not supported");
  if (colorMapType !== 0 && type !== 2 && type !== 10 && type !== 3 && type !== 11) {
    throw new Error("colour-mapped TGA files are not supported");
  }
  checkSize(width, height);
  const grey = type === 3 || type === 11;
  if (grey ? bits !== 8 : bits !== 24 && bits !== 32) throw new Error(`${bits}-bit TGA files are not supported`);
  const bytesPer = bits / 8;
  let p = 18 + idLength + (colorMapType ? mapLength * Math.ceil(mapBits / 8) : 0);

  const count = width * height;
  const raw = new Uint8Array(count * bytesPer);
  if (type === 2 || type === 3) {
    raw.set(b.subarray(p, p + raw.length));
  } else {
    let at = 0;
    while (at < raw.length && p < b.length) {
      const head = b[p++];
      const n = (head & 0x7f) + 1;
      if (head & 0x80) {
        for (let k = 0; k < n && at < raw.length; k += 1) {
          raw.set(b.subarray(p, p + bytesPer), at);
          at += bytesPer;
        }
        p += bytesPer;
      } else {
        const len = Math.min(n * bytesPer, raw.length - at);
        raw.set(b.subarray(p, p + len), at);
        p += n * bytesPer;
        at += len;
      }
    }
  }

  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  const data = new Uint8Array(count * 4);
  for (let row = 0; row < height; row += 1) {
    const y = topDown ? row : height - 1 - row;
    for (let col = 0; col < width; col += 1) {
      const x = rightToLeft ? width - 1 - col : col;
      const from = (row * width + col) * bytesPer;
      const to = (y * width + x) * 4;
      if (grey) {
        data[to] = data[to + 1] = data[to + 2] = raw[from];
        data[to + 3] = 255;
      } else {
        data[to] = raw[from + 2];
        data[to + 1] = raw[from + 1];
        data[to + 2] = raw[from];
        data[to + 3] = bytesPer === 4 ? raw[from + 3] : 255;
      }
    }
  }
  return { width, height, data };
}

/** Write a 32-bit uncompressed TGA with alpha, top-left origin. */
export function encodeTga(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error("pixel buffer does not match the image size");
  const out = Buffer.alloc(18 + rgba.length + 26);
  out[2] = 2;
  out.writeUInt16LE(width, 12);
  out.writeUInt16LE(height, 14);
  out[16] = 32;
  out[17] = 0x28; // top-left origin, 8 alpha bits
  for (let i = 0; i < width * height; i += 1) {
    const at = 18 + i * 4;
    out[at] = rgba[i * 4 + 2];
    out[at + 1] = rgba[i * 4 + 1];
    out[at + 2] = rgba[i * 4];
    out[at + 3] = rgba[i * 4 + 3];
  }
  out.write("TRUEVISION-XFILE.\0", 18 + rgba.length, "latin1");
  return out;
}

/** Which kind of picture these bytes are, by their first bytes. */
export function sniffImage(input) {
  const b = Buffer.from(input.subarray ? input.subarray(0, 16) : input);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return "png";
  if (b.toString("latin1", 0, 3) === "GIF") return "gif";
  if (b.toString("latin1", 0, 2) === "BM") return "bmp";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b.length >= 8 && looksLikeFlashDat(b)) return "flashdat";
  return "tga"; // TGA has no magic number; it is the last thing to try
}

/**
 * A Flash lossless `.dat` starts u16 0x0503, u16 row bytes, u16 width,
 * u16 height — with row bytes matching a 3- or 4-byte pixel. A real TGA
 * cannot begin this way (its second byte would be a colour-map type 5,
 * which does not exist), so this check steals nothing from it.
 */
function looksLikeFlashDat(b) {
  if (b.readUInt16LE(0) !== 0x0503) return false;
  const rowBytes = b.readUInt16LE(2);
  const width = b.readUInt16LE(4);
  const height = b.readUInt16LE(6);
  if (!width || !height || width > 8192 || height > 8192) return false;
  return rowBytes === width * 4 || rowBytes === width * 3;
}

/**
 * Decode any supported still or animated picture.
 * @returns {{kind: string, width: number, height: number, frames: {data: Uint8Array, delay: number}[]}}
 *   `delay` is in hundredths of a second (0 for stills).
 */
export function decodeImage(input) {
  const kind = sniffImage(input);
  if (kind === "jpeg") throw new Error("JPEG files are not supported here; convert to PNG first");
  if (kind === "gif") {
    const gif = decodeGif(input);
    return {
      kind,
      width: gif.width,
      height: gif.height,
      frames: gif.frames.map((f) => ({ data: f.rgba, delay: f.delay })),
    };
  }
  const still =
    kind === "png" ? decodePng(Buffer.from(input)) :
    kind === "bmp" ? decodeBmp(input) :
    kind === "flashdat" ? decodeFlashDat(input) :
    decodeTga(input);
  const data = still.data.length === still.width * still.height * 4 ? still.data : toRgba(still);
  return { kind, width: still.width, height: still.height, frames: [{ data, delay: 0 }] };
}

function toRgba(still) {
  const out = new Uint8Array(still.width * still.height * 4);
  for (let i = 0; i < still.width * still.height; i += 1) {
    out[i * 4] = still.data[i * 3];
    out[i * 4 + 1] = still.data[i * 3 + 1];
    out[i * 4 + 2] = still.data[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/**
 * Flash's lossless `.dat` bitmap (XFL `bin/*.dat`, Animate CS5+): a 26-byte
 * header, then one zlib stream split into pieces of a u16 length each, up
 * to a zero terminator. The header is u16 0x0503, u16 row bytes, u16
 * width, u16 height, four u32s of the bitmap's twip rectangle, and two
 * flag bytes. Inflated, every row is 4 bytes A, R, G, B with the colour
 * premultiplied by alpha (or 3 bytes R, G, B when the row is narrow).
 */
function decodeFlashDat(input) {
  const b = Buffer.from(input);
  if (b.length < 28 || !looksLikeFlashDat(b)) throw new Error("not a Flash lossless bitmap");
  const rowBytes = b.readUInt16LE(2);
  const width = b.readUInt16LE(4);
  const height = b.readUInt16LE(6);

  const pieces = [];
  let at = 26;
  for (;;) {
    if (at + 2 > b.length) throw new Error("not a Flash lossless bitmap (its piece list runs past the file)");
    const len = b.readUInt16LE(at);
    if (!len) break;
    if (at + 2 + len > b.length) throw new Error("not a Flash lossless bitmap (a piece runs past the file)");
    pieces.push(b.subarray(at + 2, at + 2 + len));
    at += 2 + len;
  }
  if (!pieces.length) throw new Error("not a Flash lossless bitmap (it has no data pieces)");
  const stream = Buffer.concat(pieces);
  const raw = inflateSync(stream);
  if (raw.length !== rowBytes * height) {
    throw new Error(`Flash lossless bitmap inflates to ${raw.length} bytes, expected ${rowBytes * height}`);
  }

  const data = new Uint8Array(width * height * 4);
  if (rowBytes === width * 4) {
    for (let y = 0; y < height; y += 1) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x += 1) {
        const inAt = row + x * 4;
        const outAt = (y * width + x) * 4;
        const a = raw[inAt];
        data[outAt + 3] = a;
        if (a === 255 || a === 0) {
          data[outAt] = a ? raw[inAt + 1] : 0;
          data[outAt + 1] = a ? raw[inAt + 2] : 0;
          data[outAt + 2] = a ? raw[inAt + 3] : 0;
        } else {
          // premultiplied -> straight: divide the colour back out by alpha
          data[outAt] = Math.min(255, Math.round((raw[inAt + 1] * 255) / a));
          data[outAt + 1] = Math.min(255, Math.round((raw[inAt + 2] * 255) / a));
          data[outAt + 2] = Math.min(255, Math.round((raw[inAt + 3] * 255) / a));
        }
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x += 1) {
        const inAt = row + x * 3;
        const outAt = (y * width + x) * 4;
        data[outAt] = raw[inAt];
        data[outAt + 1] = raw[inAt + 1];
        data[outAt + 2] = raw[inAt + 2];
        data[outAt + 3] = 255;
      }
    }
  }
  return { width, height, data };
}
