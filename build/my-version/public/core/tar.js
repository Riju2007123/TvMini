import { Buffer } from "./bytes.js";

/**
 * Writing TAR archives.
 *
 * The picture of a Clip Studio Paint brush is kept in a material file, and
 * that file is a TAR archive: a few pictures and a small XML file. A TAR
 * file is a list of headers, each 512 bytes long, followed by the file
 * itself, padded so that every file starts on a multiple of 512 bytes.
 */

const BLOCK = 512;

/** Write the number in the way a TAR header wants it: in octal, with a zero. */
function octal(value, width) {
  const text = Math.max(0, Math.floor(value)).toString(8);
  return Buffer.from(`${text.padStart(width - 1, "0")}\0`, "ascii");
}

/** Write the text in the way a TAR header wants it: padded with zeros. */
function text(value, width) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > width) return bytes.subarray(0, width);
  const out = Buffer.alloc(width);
  bytes.copy(out);
  return out;
}

/** The header of one file. */
function header(name, size) {
  const block = Buffer.alloc(BLOCK);
  text(name, 100).copy(block, 0);
  octal(0o644, 8).copy(block, 100); // the mode
  octal(0, 8).copy(block, 108); // the owner
  octal(0, 8).copy(block, 116); // the group
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136); // the time
  // The checksum is the sum of the bytes of the header with the room for the
  // checksum itself filled with spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  octal(sum, 8).copy(block, 148);
  block.write("0", 156, 1, "ascii"); // a plain file
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  return block;
}

/**
 * Make a TAR archive.
 *
 * `files` is a list of `{ name, data }`, where the data is a byte array.
 * The names are the paths inside the archive, with slashes between the
 * folders.
 */
export function writeTar(files) {
  const parts = [];
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? []);
    parts.push(header(file.name, data.length));
    parts.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  // The archive ends with two blocks of zeros.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * The files inside a TAR archive.
 *
 * This is what the reader of a brush uses to find the picture of the tip.
 */
export function readTar(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const files = [];
  let at = 0;
  while (at + BLOCK <= data.length) {
    const name = data.toString("utf8", at, at + 100).replace(/\0.*$/, "");
    const size = Number.parseInt(
      data.toString("ascii", at + 124, at + 136).replace(/\0.*$/, "").trim(),
      8,
    ) || 0;
    if (!name && !size) {
      at += BLOCK;
      continue;
    }
    files.push({ name, size, data: data.subarray(at + BLOCK, at + BLOCK + size) });
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
